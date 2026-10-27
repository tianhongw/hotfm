package logo

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"hotfm/server/internal/netguard"
)

func newLogoTestCache(t *testing.T) *Cache {
	t.Helper()
	return &Cache{
		Dir:       t.TempDir(),
		Client:    netguard.NewClient(netguard.Options{AllowPrivate: true}),
		UserAgent: "test",
	}
}

func logoPNG() []byte {
	return append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x00, 0x01, 0x02}, 64)...)
}

// logoServer starts an upstream whose behaviour can be switched between a PNG,
// a status code and a 404 via the returned state.
type logoUpstream struct {
	hits   atomic.Int32
	status atomic.Int32
	body   atomic.Value // []byte
	delay  atomic.Int64 // nanoseconds
}

func (u *logoUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.hits.Add(1)
	if d := time.Duration(u.delay.Load()); d > 0 {
		time.Sleep(d)
	}
	if code := int(u.status.Load()); code != http.StatusOK {
		w.WriteHeader(code)
		return
	}
	body, _ := u.body.Load().([]byte)
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(body)
}

func (u *logoUpstream) set(status int) {
	u.status.Store(int32(status))
}

func (u *logoUpstream) setBody(b []byte) {
	u.body.Store(b)
}

func logoMarker(t *testing.T, c *Cache, stationID, src string) []byte {
	t.Helper()
	b, err := os.ReadFile(c.path(stationID, src))
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	return b
}

func ageFile(t *testing.T, p string, age time.Duration) {
	t.Helper()
	mod := time.Now().Add(-age)
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

func TestLogoDefinitiveMiss(t *testing.T) {
	up := &logoUpstream{}
	up.set(http.StatusNotFound)
	srv := httptest.NewServer(up)
	defer srv.Close()

	c := newLogoTestCache(t)
	src := srv.URL + "/favicon.ico"
	marker := c.path("s1", src)

	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrNoLogo) {
		t.Fatalf("err = %v, want ErrNoLogo", err)
	}
	if b := logoMarker(t, c, "s1", src); len(b) != 0 {
		t.Fatalf("definitive marker = %q, want empty file", b)
	}
	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrNoLogo) {
		t.Fatalf("second err = %v, want ErrNoLogo", err)
	}
	if got := up.hits.Load(); got != 1 {
		t.Fatalf("upstream hits = %d, want 1 (cached miss)", got)
	}

	// Age the marker past missTTL and serve a logo from now on.
	ageFile(t, marker, 8*24*time.Hour)
	up.set(http.StatusOK)
	up.setBody(logoPNG())
	img, err := c.Get(context.Background(), "s1", src)
	if err != nil {
		t.Fatalf("after TTL: %v", err)
	}
	if img.ContentType != "image/png" || !bytes.Equal(img.Data, logoPNG()) {
		t.Fatalf("after TTL: img = %+v", img)
	}
	if got := up.hits.Load(); got != 2 {
		t.Fatalf("upstream hits = %d, want 2", got)
	}
}

func TestLogoTransientMiss(t *testing.T) {
	up := &logoUpstream{}
	up.set(http.StatusInternalServerError)
	srv := httptest.NewServer(up)
	defer srv.Close()

	c := newLogoTestCache(t)
	src := srv.URL + "/favicon.ico"
	marker := c.path("s1", src)

	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrTransient) {
		t.Fatalf("err = %v, want ErrTransient", err)
	}
	if b := logoMarker(t, c, "s1", src); len(b) != 1 || b[0] != transientMark {
		t.Fatalf("transient marker = %q, want %q", b, string(transientMark))
	}
	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrTransient) {
		t.Fatalf("second err = %v, want ErrTransient", err)
	}
	if got := up.hits.Load(); got != 1 {
		t.Fatalf("upstream hits = %d, want 1 (transient cached)", got)
	}

	// After the short TTL the logo is retried.
	ageFile(t, marker, 2*time.Hour)
	up.set(http.StatusOK)
	up.setBody(logoPNG())
	img, err := c.Get(context.Background(), "s1", src)
	if err != nil {
		t.Fatalf("after transient TTL: %v", err)
	}
	if img.ContentType != "image/png" {
		t.Fatalf("after transient TTL: %+v", img)
	}
	if got := up.hits.Load(); got != 2 {
		t.Fatalf("upstream hits = %d, want 2", got)
	}
}

func TestLogoTransientTimeout(t *testing.T) {
	up := &logoUpstream{}
	up.set(http.StatusOK)
	up.setBody(logoPNG())
	up.delay.Store(int64(200 * time.Millisecond))
	srv := httptest.NewServer(up)
	defer srv.Close()

	c := newLogoTestCache(t)
	c.Client = &http.Client{Timeout: 20 * time.Millisecond}
	src := srv.URL + "/favicon.ico"

	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrTransient) {
		t.Fatalf("err = %v, want ErrTransient", err)
	}
	if b := logoMarker(t, c, "s1", src); len(b) != 1 || b[0] != transientMark {
		t.Fatalf("timeout marker = %q, want %q", b, string(transientMark))
	}
}

func TestLogoStatusClassification(t *testing.T) {
	cases := []struct {
		status    int
		transient bool
	}{
		{http.StatusRequestTimeout, true},
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
		{http.StatusServiceUnavailable, true},
		{http.StatusForbidden, false},
		{http.StatusGone, false},
		{http.StatusNotFound, false},
		{http.StatusMovedPermanently, false},
	}
	for _, c := range cases {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			up := &logoUpstream{}
			up.set(c.status)
			srv := httptest.NewServer(up)
			defer srv.Close()

			cache := newLogoTestCache(t)
			src := srv.URL + "/favicon.ico"
			_, err := cache.Get(context.Background(), "s1", src)
			if c.transient {
				if !errors.Is(err, ErrTransient) {
					t.Fatalf("status %d: err = %v, want ErrTransient", c.status, err)
				}
				if b := logoMarker(t, cache, "s1", src); len(b) != 1 {
					t.Fatalf("status %d: marker = %q", c.status, b)
				}
				return
			}
			if !errors.Is(err, ErrNoLogo) {
				t.Fatalf("status %d: err = %v, want ErrNoLogo", c.status, err)
			}
			if b := logoMarker(t, cache, "s1", src); len(b) != 0 {
				t.Fatalf("status %d: marker = %q, want empty", c.status, b)
			}
		})
	}
}

func TestLogoNonImage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>nope</html>"))
	}))
	defer srv.Close()

	c := newLogoTestCache(t)
	src := srv.URL + "/favicon.ico"
	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrNoLogo) {
		t.Fatalf("err = %v, want ErrNoLogo", err)
	}
	if b := logoMarker(t, c, "s1", src); len(b) != 0 {
		t.Fatalf("marker = %q, want empty", b)
	}
}

func TestLogoOversize(t *testing.T) {
	big := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 600<<10)...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(big)
	}))
	defer srv.Close()

	c := newLogoTestCache(t)
	src := srv.URL + "/favicon.png"
	if _, err := c.Get(context.Background(), "s1", src); !errors.Is(err, ErrNoLogo) {
		t.Fatalf("err = %v, want ErrNoLogo", err)
	}
	if b := logoMarker(t, c, "s1", src); len(b) != 0 {
		t.Fatalf("marker = %q, want empty", b)
	}
}

func TestLogoHitAndReuse(t *testing.T) {
	up := &logoUpstream{}
	up.set(http.StatusOK)
	up.setBody(logoPNG())
	srv := httptest.NewServer(up)
	defer srv.Close()

	c := newLogoTestCache(t)
	src := srv.URL + "/favicon.png"
	img, err := c.Get(context.Background(), "s1", src)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if img.ContentType != "image/png" {
		t.Fatalf("ContentType = %q", img.ContentType)
	}
	if !bytes.Equal(img.Data, logoPNG()) {
		t.Fatalf("data mismatch")
	}
	again, err := c.Get(context.Background(), "s1", src)
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if !bytes.Equal(again.Data, img.Data) || again.ContentType != img.ContentType {
		t.Fatalf("cached image differs")
	}
	if got := up.hits.Load(); got != 1 {
		t.Fatalf("upstream hits = %d, want 1", got)
	}
	if b := logoMarker(t, c, "s1", src); len(b) <= 1 {
		t.Fatalf("hit marker too short: %q", b)
	}
}

func TestLogoEmptyFavicon(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newLogoTestCache(t)
	if _, err := c.Get(context.Background(), "s1", ""); !errors.Is(err, ErrNoLogo) {
		t.Fatalf("err = %v, want ErrNoLogo", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream hits = %d, want 0", hits.Load())
	}
	if _, err := os.Stat(c.path("s1", "")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("marker file written for empty favicon: %v", err)
	}
}
