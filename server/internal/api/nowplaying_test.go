package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hotfm/server/internal/config"
	"hotfm/server/internal/netguard"
	"hotfm/server/internal/store"
	"hotfm/server/internal/stream"
)

// npMetaBlock builds one ICY metadata block (length byte + 16-byte units).
func npMetaBlock(s string) []byte {
	n := (len(s) + 15) / 16
	b := make([]byte, 1+n*16)
	b[0] = byte(n)
	copy(b[1:], s)
	return b
}

func npLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// npUpstream serves an endless ICY stream with one title and counts connections.
func npUpstream(t *testing.T, requests *atomic.Int32, title string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("icy-metaint", "16")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, 16))
		_, _ = w.Write(npMetaBlock("StreamTitle='" + title + "';"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

// npAPI starts an API server over a throwaway store holding the given stations.
func npAPI(t *testing.T, cfg *config.Config, wp *stream.NowPlaying, stations ...store.Station) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.ReplaceCountry(context.Background(), "US", stations, time.Now()); err != nil {
		t.Fatalf("seed stations: %v", err)
	}
	srv := New(Deps{
		Config:     cfg,
		Store:      st,
		Hub:        stream.NewHub(),
		NowPlaying: wp,
		Log:        npLog(),
	})
	ts := httptest.NewServer(srv.Handler(nil))
	t.Cleanup(ts.Close)
	return ts
}

func npNowPlaying(upstream *http.Client, maxWatchers int) *stream.NowPlaying {
	np := stream.NewNowPlaying(upstream, "test-agent", npLog(), maxWatchers)
	np.Linger = 20 * time.Millisecond
	return np
}

// npOpenNowPlaying issues the SSE request and keeps it open until the returned
// cancel func is called.
func npOpenNowPlaying(t *testing.T, url string) (*http.Response, *bufio.Reader, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("GET nowplaying: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp, bufio.NewReader(resp.Body), cancel
}

// npReadFrame reads until a line matching pred appears; every line seen is
// reported to onLine (may be nil).
func npReadLine(t *testing.T, br *bufio.Reader, pred func(string) bool) string {
	t.Helper()
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE: %v", err)
		}
		if pred(line) {
			return line
		}
	}
}

func TestHandleNowPlayingRejectsHLS(t *testing.T) {
	wp := npNowPlaying(netguard.NewClient(netguard.Options{AllowPrivate: true}), 4)
	ts := npAPI(t, &config.Config{MaxSubsPerIP: 4}, wp, store.Station{
		ID: "hls1", Name: "HLS Station", Country: "US", HLS: true,
		StreamURL: "https://example.com/live.m3u8",
	})
	resp, err := http.Get(ts.URL + "/api/v1/stations/hls1/nowplaying")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
	var body errorBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "is_hls" {
		t.Fatalf("code = %q, want is_hls", body.Error.Code)
	}
}

func TestHandleNowPlayingStreamsTitles(t *testing.T) {
	var requests atomic.Int32
	up := npUpstream(t, &requests, "Artist - Song")
	wp := npNowPlaying(netguard.NewClient(netguard.Options{AllowPrivate: true}), 4)
	ts := npAPI(t, &config.Config{MaxSubsPerIP: 4}, wp, store.Station{
		ID: "s1", Name: "Direct Station", Country: "US", StreamURL: up.URL,
	})

	resp, br, cancel := npOpenNowPlaying(t, ts.URL+"/api/v1/stations/s1/nowplaying")
	defer cancel()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}
	npReadLine(t, br, func(l string) bool { return strings.TrimSpace(l) == "retry: 5000" })
	line := npReadLine(t, br, func(l string) bool { return strings.HasPrefix(l, "data: ") })
	if !strings.Contains(line, `"title":"Artist - Song"`) {
		t.Fatalf("title frame = %q", line)
	}
}

func TestHandleNowPlayingLimitsSubscriptionsPerIP(t *testing.T) {
	var requests atomic.Int32
	up := npUpstream(t, &requests, "Artist - Song")
	wp := npNowPlaying(netguard.NewClient(netguard.Options{AllowPrivate: true}), 4)
	ts := npAPI(t, &config.Config{MaxSubsPerIP: 1}, wp, store.Station{
		ID: "s1", Name: "Direct Station", Country: "US", StreamURL: up.URL,
	})

	_, br, cancel := npOpenNowPlaying(t, ts.URL+"/api/v1/stations/s1/nowplaying")
	defer cancel()
	npReadLine(t, br, func(l string) bool { return strings.TrimSpace(l) == "retry: 5000" })

	resp, err := http.Get(ts.URL + "/api/v1/stations/s1/nowplaying")
	if err != nil {
		t.Fatalf("second GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}
	if resp.Header.Get("Retry-After") != "30" {
		t.Fatalf("Retry-After = %q", resp.Header.Get("Retry-After"))
	}
	var body errorBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "too_many_subscriptions" {
		t.Fatalf("code = %q, want too_many_subscriptions", body.Error.Code)
	}
}

func TestHandleNowPlayingReportsWatcherCapacity(t *testing.T) {
	var requests atomic.Int32
	up := npUpstream(t, &requests, "Artist - Song")
	up2 := npUpstream(t, &requests, "Other - Song")
	wp := npNowPlaying(netguard.NewClient(netguard.Options{AllowPrivate: true}), 1)
	ts := npAPI(t, &config.Config{MaxSubsPerIP: 4}, wp,
		store.Station{ID: "a", Name: "A", Country: "US", StreamURL: up.URL},
		store.Station{ID: "b", Name: "B", Country: "US", StreamURL: up2.URL},
	)

	// Occupy the only watcher slot, then ask for a second station.
	_, _, release, err := wp.Subscribe(&store.Station{ID: "a", StreamURL: up.URL})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer release()

	resp, err := http.Get(ts.URL + "/api/v1/stations/b/nowplaying")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}
	var body errorBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "watcher_limit" {
		t.Fatalf("code = %q, want watcher_limit", body.Error.Code)
	}
}

func TestHandleNowPlayingUnknownStation(t *testing.T) {
	wp := npNowPlaying(netguard.NewClient(netguard.Options{AllowPrivate: true}), 4)
	ts := npAPI(t, &config.Config{MaxSubsPerIP: 4}, wp)
	resp, err := http.Get(ts.URL + "/api/v1/stations/nope/nowplaying")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}
