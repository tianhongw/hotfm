package health

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"hotfm/server/internal/netguard"
)

func mp3Frames(n int) []byte {
	frame := append([]byte{0xFF, 0xFB, 0x90, 0x64}, bytes.Repeat([]byte{0}, 413)...)
	return bytes.Repeat(frame, n)
}

func TestProbe(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/mp3", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write(mp3Frames(20))
	})
	mux.HandleFunc("/untyped", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(mp3Frames(20))
	})
	mux.HandleFunc("/html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(strings.Repeat("<p>gone</p>", 500)))
	})
	mux.HandleFunc("/short", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write([]byte{0xFF, 0xFB})
	})
	mux.HandleFunc("/404", http.NotFound)
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	mux.HandleFunc("/master.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nmedia.m3u8\n"))
	})
	mux.HandleFunc("/media.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXTINF:10,\nseg1.aac\n"))
	})
	mux.HandleFunc("/seg1.aac", func(w http.ResponseWriter, r *http.Request) {
		w.Write(bytes.Repeat([]byte{0xFF, 0xF1, 0x50, 0x80}, 200))
	})
	mux.HandleFunc("/broken.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXTINF:10,\nmissing.ts\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := &Prober{Client: netguard.NewClient(netguard.Options{AllowPrivate: true}), UserAgent: "test", Timeout: time.Second}
	cases := []struct {
		path    string
		ok, hls bool
	}{
		{"/mp3", true, false},
		{"/untyped", true, false},
		{"/html", false, false},
		{"/short", false, false},
		{"/404", false, false},
		{"/slow", false, false},
		{"/master.m3u8", true, true},
		{"/broken.m3u8", false, true},
	}
	for _, c := range cases {
		res := p.Probe(context.Background(), srv.URL+c.path)
		if res.OK != c.ok || res.IsHLS != c.hls {
			t.Errorf("%s: got %+v, want ok=%v hls=%v", c.path, res, c.ok, c.hls)
		}
		if !res.OK && res.Err == "" {
			t.Errorf("%s: failure without error message", c.path)
		}
	}
}
