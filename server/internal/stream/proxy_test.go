package stream

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"hotfm/server/internal/netguard"
	"hotfm/server/internal/store"
)

func newTestProxy() *Proxy {
	return &Proxy{
		Client:    netguard.NewClient(netguard.Options{AllowPrivate: true}),
		Hub:       NewHub(),
		Signer:    Signer{Secret: []byte("s"), TTL: time.Hour},
		UserAgent: "test",
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Limit:     &IPLimiter{Max: 2},
	}
}

func TestServeAudioStripsMetadataAndPublishesTitle(t *testing.T) {
	audio := bytes.Repeat([]byte{0xFF, 0xFB, 0x90, 0x00}, 4) // 16 bytes per block
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Icy-MetaData") != "1" {
			t.Error("Icy-MetaData not requested")
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("icy-metaint", "16")
		w.Write(audio)
		w.Write(metaBlock("StreamTitle='Artist - Song';"))
		w.Write(audio)
		w.Write([]byte{0})
	}))
	defer upstream.Close()

	p := newTestProxy()
	var healthy bool
	p.OnHealthy = func(string) { healthy = true }
	updates, _, cancel := p.Hub.Subscribe("session-1")
	defer cancel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/stream/x?sid=session-1", nil)
	st := &store.Station{ID: "x", StreamURL: upstream.URL, Codec: "MP3"}
	if err := p.ServeAudio(rec, req, st, "session-1"); err != nil {
		t.Fatal(err)
	}
	if got := rec.Body.Bytes(); !bytes.Equal(got, append(append([]byte{}, audio...), audio...)) {
		t.Fatalf("relayed %d bytes with metadata not stripped: %q", len(got), got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("content-type %q", ct)
	}
	select {
	case title := <-updates:
		if title != "Artist - Song" {
			t.Fatalf("title %q", title)
		}
	default:
		t.Fatal("no title published")
	}
	if healthy {
		t.Fatal("tiny stream must not count as healthy playback")
	}
}

func TestServeAudioRejectsNonAudio(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"not_audio": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, "<html>gone</html>")
		},
		"is_hls": func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, "#EXTM3U\n#EXTINF:10,\na.ts\n")
		},
		"upstream_status": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 404) },
	}
	for code, h := range cases {
		upstream := httptest.NewServer(h)
		p := newTestProxy()
		failed := false
		p.OnFailure = func(string, error) { failed = true }
		err := p.ServeAudio(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), &store.Station{ID: "x", StreamURL: upstream.URL}, "")
		upstream.Close()
		se, ok := err.(*Error)
		if !ok || se.Code != code {
			t.Errorf("%s: got %v", code, err)
		}
		if code != "is_hls" && !failed {
			t.Errorf("%s: failure not reported to health checker", code)
		}
	}
}

func TestIPLimiter(t *testing.T) {
	l := &IPLimiter{Max: 2}
	r1, ok1 := l.Acquire("a")
	_, ok2 := l.Acquire("a")
	_, ok3 := l.Acquire("a")
	if !ok1 || !ok2 || ok3 {
		t.Fatal("limit not enforced")
	}
	r1()
	if _, ok := l.Acquire("a"); !ok {
		t.Fatal("release did not free a slot")
	}
}

func TestServeHLSRewritesRootPlaylist(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nlow/index.m3u8\n")
	}))
	defer upstream.Close()
	p := newTestProxy()
	rec := httptest.NewRecorder()
	st := &store.Station{ID: "x", StreamURL: upstream.URL + "/live/master.m3u8"}
	if err := p.ServeHLS(rec, httptest.NewRequest("GET", "/", nil), st, ""); err != nil {
		t.Fatal(err)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "/api/v1/hls/x/r?") || strings.Contains(body, "\nlow/index.m3u8") {
		t.Fatalf("playlist not rewritten:\n%s", body)
	}
}
