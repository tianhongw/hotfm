package stream

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"

	"hotfm/server/internal/netguard"
	"hotfm/server/internal/store"
)

func npTestClient() *http.Client {
	return netguard.NewClient(netguard.Options{AllowPrivate: true})
}

func npTestLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// npIcyUpstream serves an endless ICY stream carrying one title and counts
// connections. It ends when the client goes away.
func npIcyUpstream(t *testing.T, requests *atomic.Int32, title string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("icy-metaint", "16")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, 16))
		_, _ = w.Write(metaBlock("StreamTitle='" + title + "';"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

func npWaitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func npRunning(n *NowPlaying) int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.running
}

func npTitle(t *testing.T, ch <-chan string, timeout time.Duration) string {
	t.Helper()
	select {
	case got := <-ch:
		return got
	case <-time.After(timeout):
		t.Fatalf("no title within %v", timeout)
		return ""
	}
}

func TestNowPlayingSharesOneUpstream(t *testing.T) {
	var requests atomic.Int32
	srv := npIcyUpstream(t, &requests, "Artist - Song")
	n := NewNowPlaying(npTestClient(), "test-agent", npTestLog(), 4)
	n.Linger = 20 * time.Millisecond
	st := &store.Station{ID: "s1", StreamURL: srv.URL, Country: "US"}

	ch1, current, release1, err := n.Subscribe(st)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer release1()
	if current != "" {
		t.Fatalf("current = %q, want empty", current)
	}
	if got := npTitle(t, ch1, 2*time.Second); got != "Artist - Song" {
		t.Fatalf("title = %q", got)
	}

	ch2, current2, release2, err := n.Subscribe(st)
	if err != nil {
		t.Fatalf("Subscribe second: %v", err)
	}
	defer release2()
	if current2 != "Artist - Song" {
		t.Fatalf("current for second subscriber = %q", current2)
	}
	time.Sleep(100 * time.Millisecond)
	if got := requests.Load(); got != 1 {
		t.Fatalf("upstream connections = %d, want 1", got)
	}
	select {
	case got := <-ch2:
		t.Fatalf("second subscriber replayed %q; only changes are published", got)
	default:
	}

	release1()
	release2()
	if !npWaitFor(t, 2*time.Second, func() bool { return npRunning(n) == 0 }) {
		t.Fatal("watcher did not stop after the last subscriber left")
	}
}

func TestNowPlayingNegativeCacheWithoutMetaint(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, 32))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)

	n := NewNowPlaying(npTestClient(), "test-agent", npTestLog(), 4)
	n.NoMetaTTL = time.Hour
	n.Linger = 20 * time.Millisecond
	st := &store.Station{ID: "s2", StreamURL: srv.URL}

	ch, current, release, err := n.Subscribe(st)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if current != "" {
		t.Fatalf("current = %q, want empty", current)
	}
	select {
	case got := <-ch:
		t.Fatalf("unexpected title %q from a station without icy-metaint", got)
	case <-time.After(100 * time.Millisecond):
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("upstream connections = %d, want 1", got)
	}
	release()
	if !npWaitFor(t, 2*time.Second, func() bool { return npRunning(n) == 0 }) {
		t.Fatal("watcher did not stop after the last subscriber left")
	}
	time.Sleep(60 * time.Millisecond) // let the linger timer fire

	ch2, current2, release2, err := n.Subscribe(st)
	if err != nil {
		t.Fatalf("Subscribe after negative cache: %v", err)
	}
	defer release2()
	if current2 != "" {
		t.Fatalf("current = %q, want empty", current2)
	}
	select {
	case got := <-ch2:
		t.Fatalf("unexpected title %q", got)
	case <-time.After(100 * time.Millisecond):
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("upstream connections = %d, want 1 (negative cache should outlive subscribers)", got)
	}
}

func TestNowPlayingCapacity(t *testing.T) {
	var reqA, reqB atomic.Int32
	srvA := npIcyUpstream(t, &reqA, "A - One")
	srvB := npIcyUpstream(t, &reqB, "B - Two")

	n := NewNowPlaying(npTestClient(), "test-agent", npTestLog(), 1)
	n.Linger = 20 * time.Millisecond
	stA := &store.Station{ID: "a", StreamURL: srvA.URL}
	stB := &store.Station{ID: "b", StreamURL: srvB.URL}

	chA, _, releaseA, err := n.Subscribe(stA)
	if err != nil {
		t.Fatalf("Subscribe A: %v", err)
	}
	if got := npTitle(t, chA, 2*time.Second); got != "A - One" {
		t.Fatalf("title A = %q", got)
	}
	if _, _, _, err := n.Subscribe(stB); !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("Subscribe B error = %v, want ErrNoCapacity", err)
	}
	releaseA()

	var chB <-chan string
	var releaseB func()
	ok := npWaitFor(t, 2*time.Second, func() bool {
		ch, _, rel, err := n.Subscribe(stB)
		if err != nil {
			if !errors.Is(err, ErrNoCapacity) {
				t.Fatalf("Subscribe B error = %v", err)
			}
			return false
		}
		chB, releaseB = ch, rel
		return true
	})
	if !ok {
		t.Fatal("capacity was never freed")
	}
	defer releaseB()
	if got := npTitle(t, chB, 2*time.Second); got != "B - Two" {
		t.Fatalf("title B = %q", got)
	}
	releaseB()
	if !npWaitFor(t, 2*time.Second, func() bool { return npRunning(n) == 0 }) {
		t.Fatal("watcher did not stop after the last subscriber left")
	}
}

func TestNowPlayingGB18030Title(t *testing.T) {
	gbk, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("周杰伦 - 晴天"))
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	srv := npIcyUpstream(t, &requests, string(gbk))

	n := NewNowPlaying(npTestClient(), "test-agent", npTestLog(), 4)
	n.Linger = 20 * time.Millisecond
	st := &store.Station{ID: "cn", StreamURL: srv.URL, Country: "CN"}

	ch, _, release, err := n.Subscribe(st)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer release()
	if got := npTitle(t, ch, 2*time.Second); got != "周杰伦 - 晴天" {
		t.Fatalf("title = %q", got)
	}
	release()
	if !npWaitFor(t, 2*time.Second, func() bool { return npRunning(n) == 0 }) {
		t.Fatal("watcher did not stop after the last subscriber left")
	}
}
