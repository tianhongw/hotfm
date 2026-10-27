// Package logo proxies and disk-caches station favicons so the web app never
// loads third-party (often plain-http or broken) image URLs directly.
package logo

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	maxBytes     = 512 << 10
	missTTL      = 7 * 24 * time.Hour // definitive: upstream says there is no logo
	transientTTL = time.Hour          // retryable failure: retry within the hour
	hitTTL       = 30 * 24 * time.Hour
	fetchTimout  = 10 * time.Second
)

// transientMark is the marker file body for retryable failures; a zero-byte
// marker (the original format) still means a definitive miss.
const transientMark = '~'

var (
	// ErrNoLogo means the station definitively has no usable favicon.
	ErrNoLogo = errors.New("no logo")
	// ErrTransient means the favicon fetch failed for a retryable reason.
	ErrTransient = errors.New("logo fetch failed")
)

type Cache struct {
	Dir       string
	Client    *http.Client
	UserAgent string
	group     singleflight.Group
}

type Image struct {
	Data        []byte
	ContentType string
}

func (c *Cache) path(stationID, src string) string {
	h := sha1.Sum([]byte(stationID + "\n" + src))
	name := hex.EncodeToString(h[:])
	return filepath.Join(c.Dir, name[:2], name)
}

// Get returns the cached image for a station's favicon URL, fetching it on a miss.
func (c *Cache) Get(ctx context.Context, stationID, src string) (*Image, error) {
	if src == "" {
		return nil, ErrNoLogo
	}
	p := c.path(stationID, src)
	if img, err := readCached(p); err == nil || errors.Is(err, ErrNoLogo) || errors.Is(err, ErrTransient) {
		return img, err
	}
	v, err, _ := c.group.Do(p, func() (any, error) {
		img, err := c.fetch(context.WithoutCancel(ctx), src)
		if err != nil {
			writeMiss(p, errors.Is(err, ErrNoLogo))
			return nil, err
		}
		writeCached(p, img)
		return img, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*Image), nil
}

// fetch retrieves and validates a favicon. Every returned error wraps exactly
// one class: ErrNoLogo when the source is permanently unusable, ErrTransient
// when the failure is worth retrying (timeouts, 5xx, 429, ...).
func (c *Cache) fetch(ctx context.Context, src string) (*Image, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNoLogo, err)
	}
	req.Header.Set("User-Agent", c.UserAgent)
	req.Header.Set("Accept", "image/*")
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTransient, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch {
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			return nil, fmt.Errorf("%w: %s", ErrNoLogo, resp.Status)
		case resp.StatusCode == http.StatusRequestTimeout,
			resp.StatusCode == http.StatusTooManyRequests,
			resp.StatusCode >= 500:
			return nil, fmt.Errorf("%w: %s", ErrTransient, resp.Status)
		default:
			return nil, fmt.Errorf("%w: %s", ErrNoLogo, resp.Status)
		}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTransient, err)
	}
	if len(data) == 0 || len(data) > maxBytes {
		return nil, ErrNoLogo
	}
	ct := http.DetectContentType(data)
	if declared := strings.ToLower(resp.Header.Get("Content-Type")); strings.HasPrefix(declared, "image/svg") {
		ct = "image/svg+xml"
	}
	if !strings.HasPrefix(ct, "image/") {
		return nil, ErrNoLogo
	}
	return &Image{Data: data, ContentType: ct}, nil
}

// Cache files: "<ct>\n<bytes>" for hits, an empty file for definitive misses
// and a single '~' byte for transient misses.
func readCached(p string) (*Image, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if fi.Size() == 0 {
		if time.Since(fi.ModTime()) < missTTL {
			return nil, ErrNoLogo
		}
		return nil, os.ErrNotExist
	}
	if time.Since(fi.ModTime()) > hitTTL {
		return nil, os.ErrNotExist
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	// A hit body always starts with the content type, so a lone '~' is a marker.
	if len(b) == 1 && b[0] == transientMark {
		if time.Since(fi.ModTime()) < transientTTL {
			return nil, ErrTransient
		}
		return nil, os.ErrNotExist
	}
	i := strings.IndexByte(string(b[:min(len(b), 64)]), '\n')
	if i <= 0 {
		return nil, os.ErrNotExist
	}
	return &Image{ContentType: string(b[:i]), Data: b[i+1:]}, nil
}

func writeCached(p string, img *Image) {
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append([]byte(img.ContentType+"\n"), img.Data...), 0o644); err == nil {
		_ = os.Rename(tmp, p)
	}
}

// writeMiss records a negative cache entry; transient entries expire sooner.
func writeMiss(p string, definitive bool) {
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	var body []byte
	if !definitive {
		body = []byte{transientMark}
	}
	_ = os.WriteFile(p, body, 0o644)
}
