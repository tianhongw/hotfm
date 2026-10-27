package catalog

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

func syncTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func syncTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// syncTestUpstream serves /json/stations/search with the given handler.
func syncTestUpstream(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/json/stations/search" {
			http.NotFound(w, r)
			return
		}
		handle(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func syncTestEmpty(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("[]"))
}

func TestRetryDelay(t *testing.T) {
	cases := []struct {
		n        int
		interval time.Duration
		want     time.Duration
	}{
		{0, 24 * time.Hour, 0},
		{1, 24 * time.Hour, time.Minute},
		{2, 24 * time.Hour, 2 * time.Minute},
		{3, 24 * time.Hour, 5 * time.Minute},
		{4, 24 * time.Hour, 10 * time.Minute},
		{5, 24 * time.Hour, 30 * time.Minute},
		{6, 24 * time.Hour, 24 * time.Hour},
		{99, 24 * time.Hour, 24 * time.Hour},
		{1, 30 * time.Second, 30 * time.Second},
		{1, 0, time.Minute},
	}
	for _, c := range cases {
		if got := retryDelay(c.n, c.interval); got != c.want {
			t.Errorf("retryDelay(%d, %s) = %s, want %s", c.n, c.interval, got, c.want)
		}
	}
}

func TestSyncCountryReportsRunning(t *testing.T) {
	db := syncTestStore(t)
	started := make(chan struct{})
	release := make(chan struct{})
	var startedOnce sync.Once
	srv := syncTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		startedOnce.Do(func() { close(started) })
		<-release
		syncTestEmpty(w, nil)
	})

	s := &Syncer{
		Store:    db,
		Client:   radiobrowser.New("test", srv.URL),
		Interval: time.Hour,
		Log:      syncTestLogger(),
	}
	done := make(chan error, 1)
	go func() { done <- s.SyncCountry(context.Background(), "US") }()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not called")
	}
	if !s.Syncing("US") {
		t.Fatal("Syncing(US) = false while the run is in flight")
	}
	if s.Syncing("CN") {
		t.Fatal("Syncing(CN) = true")
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("SyncCountry: %v", err)
	}
	if s.Syncing("US") {
		t.Fatal("Syncing(US) = true after the run finished")
	}
	last, err := db.LastSuccessfulSync(context.Background(), "US")
	if err != nil {
		t.Fatalf("LastSuccessfulSync: %v", err)
	}
	if last.IsZero() {
		t.Fatal("LastSuccessfulSync(US) is zero after a successful run")
	}
}

func TestRunRetriesAfterFailure(t *testing.T) {
	oldLadder, oldWait := retryLadder, minWait
	retryLadder = []time.Duration{20 * time.Millisecond}
	minWait = 10 * time.Millisecond
	t.Cleanup(func() { retryLadder, minWait = oldLadder, oldWait })

	db := syncTestStore(t)
	var mu sync.Mutex
	calls := map[string]int{}
	srv := syncTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		country := r.URL.Query().Get("countrycode")
		mu.Lock()
		calls[country]++
		n := calls[country]
		mu.Unlock()
		if country == "US" && n == 1 {
			http.Error(w, "upstream down", http.StatusServiceUnavailable)
			return
		}
		syncTestEmpty(w, r)
	})

	s := &Syncer{
		Store:    db,
		Client:   radiobrowser.New("test", srv.URL),
		Interval: time.Hour,
		Log:      syncTestLogger(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Run(ctx)
	}()

	// The first US run fails; the retry ladder must bring it back quickly.
	deadline := time.Now().Add(3 * time.Second)
	var lastUS, lastCN time.Time
	for time.Now().Before(deadline) {
		var err error
		if lastUS, err = db.LastSuccessfulSync(ctx, "US"); err != nil {
			t.Fatalf("LastSuccessfulSync(US): %v", err)
		}
		if !lastUS.IsZero() {
			if lastCN, err = db.LastSuccessfulSync(ctx, "CN"); err != nil {
				t.Fatalf("LastSuccessfulSync(CN): %v", err)
			}
			if !lastCN.IsZero() {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	if lastUS.IsZero() {
		t.Fatalf("US was never retried after the failure; calls = %v", snapshotCalls(&mu, calls))
	}
	if lastCN.IsZero() {
		t.Fatalf("CN was never synced; calls = %v", snapshotCalls(&mu, calls))
	}

	// Both countries are synced now, so no further upstream traffic is expected.
	time.Sleep(50 * time.Millisecond)
	got := snapshotCalls(&mu, calls)
	if got["US"] != 2 {
		t.Fatalf("US was fetched %d times, want 2 (one 503, one retry)", got["US"])
	}
	if s.Syncing("US") || s.Syncing("CN") {
		t.Fatal("Syncing reports a run after every country finished")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

func snapshotCalls(mu *sync.Mutex, calls map[string]int) map[string]int {
	mu.Lock()
	defer mu.Unlock()
	out := make(map[string]int, len(calls))
	for k, v := range calls {
		out[k] = v
	}
	return out
}
