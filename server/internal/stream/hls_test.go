package stream

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRewritePlaylist(t *testing.T) {
	base, _ := url.Parse("http://cdn.example.com/live/radio/index.m3u8?token=1")
	in := "#EXTM3U\r\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:10,\nseg-001.ts\n#EXTINF:10,\n/abs/seg-002.ts?x=1\nhttps://other.example.com/seg-003.ts\n\n"
	got := string(RewritePlaylist([]byte(in), base, func(abs string) string { return "P(" + abs + ")" }))
	for _, want := range []string{
		`URI="P(http://cdn.example.com/live/radio/key.bin)"`,
		"P(http://cdn.example.com/live/radio/seg-001.ts)\n",
		"P(http://cdn.example.com/abs/seg-002.ts?x=1)\n",
		"P(https://other.example.com/seg-003.ts)\n",
		"#EXTINF:10,\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "\r") {
		t.Error("carriage returns not normalised")
	}
}

func TestSigner(t *testing.T) {
	s := Signer{Secret: []byte("k"), TTL: time.Hour}
	u, _ := url.Parse(s.URL("st1", "http://a/b.ts"))
	if got, ok := s.Verify("st1", u.Query()); !ok || got != "http://a/b.ts" {
		t.Fatalf("valid token rejected: %v %v", got, ok)
	}
	if _, ok := s.Verify("st2", u.Query()); ok {
		t.Fatal("token accepted for another station")
	}
	q := u.Query()
	q.Set("u", "http://evil/")
	if _, ok := s.Verify("st1", q); ok {
		t.Fatal("tampered target accepted")
	}
	expired := Signer{Secret: []byte("k"), TTL: -time.Minute}
	u2, _ := url.Parse(expired.URL("st1", "http://a/b.ts"))
	if _, ok := s.Verify("st1", u2.Query()); ok {
		t.Fatal("expired token accepted")
	}
}

func TestIsPlaylist(t *testing.T) {
	if !IsPlaylist("application/vnd.apple.mpegurl", nil) || !IsPlaylist("text/plain", []byte("\n#EXTM3U\n")) || IsPlaylist("audio/mpeg", []byte{0xff, 0xfb}) {
		t.Fatal("IsPlaylist misclassified")
	}
}
