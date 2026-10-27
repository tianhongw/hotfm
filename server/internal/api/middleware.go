package api

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"hotfm/server/internal/stream"
)

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// withBase resolves the client IP, recovers panics and writes an access log.
func (s *Server) withBase(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ip := s.clientIP(r)
		r = stream.WithClientKey(r, ip)
		sw := &statusWriter{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic", "err", rec, "path", r.URL.Path, "stack", string(debug.Stack()))
				if sw.status == 0 {
					writeError(sw, http.StatusInternalServerError, "internal", "internal error")
				}
			}
			if strings.HasPrefix(r.URL.Path, "/api/") {
				s.log.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status,
					"bytes", sw.bytes, "dur", time.Since(start).Round(time.Millisecond), "ip", ip)
			}
		}()
		if s.cfg.DevCORS {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(sw, r)
	})
}

// ipLimiter is a per-client token bucket for JSON endpoints.
type ipLimiter struct {
	mu      sync.Mutex
	clients map[string]*limiterEntry
	r       rate.Limit
	burst   int
}

type limiterEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

func newIPLimiter(r rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{clients: map[string]*limiterEntry{}, r: r, burst: burst}
}

func (l *ipLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.clients[key]
	if e == nil {
		if len(l.clients) > 50000 {
			for k, v := range l.clients {
				if time.Since(v.seen) > 10*time.Minute {
					delete(l.clients, k)
				}
			}
		}
		e = &limiterEntry{lim: rate.NewLimiter(l.r, l.burst)}
		l.clients[key] = e
	}
	e.seen = time.Now()
	return e.lim.Allow()
}

func (s *Server) rateLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.allow(s.clientIP(r)) {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
			return
		}
		next(w, r)
	}
}

var gzPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed); return w }}

// compressibleTypes are the static asset media types worth gzipping; fonts,
// images and media are already compressed formats.
var compressibleTypes = map[string]bool{
	"text/html":                 true,
	"text/css":                  true,
	"text/javascript":           true,
	"application/javascript":    true,
	"application/json":          true,
	"application/manifest+json": true,
	"image/svg+xml":             true,
	"text/plain":                true,
}

// compressibleType reports whether a Content-Type header value is worth gzipping.
func compressibleType(ct string) bool {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return compressibleTypes[strings.ToLower(strings.TrimSpace(ct))]
}

// compressWriter gzips the response only when it ends up being a 200 with a
// compressible Content-Type, so 206/304/404 pass through byte-identical and
// carry no stray gzip member.
type compressWriter struct {
	http.ResponseWriter
	// head responses have no body; advertise the encoding but do not open a
	// gzip member, whose empty stream would become a wrong Content-Length.
	head    bool
	gz      *gzip.Writer
	decided bool
}

func (c *compressWriter) decide(code int) {
	if c.decided {
		return
	}
	c.decided = true
	if code != http.StatusOK || !compressibleType(c.Header().Get("Content-Type")) {
		return
	}
	// serveContent commits Content-Length from the uncompressed size; it is
	// wrong once we set Content-Encoding after that.
	c.Header().Del("Content-Length")
	c.Header().Set("Content-Encoding", "gzip")
	if c.head {
		return
	}
	c.gz = gzPool.Get().(*gzip.Writer)
	c.gz.Reset(c.ResponseWriter)
}

func (c *compressWriter) WriteHeader(code int) {
	c.decide(code)
	c.ResponseWriter.WriteHeader(code)
}

func (c *compressWriter) Write(b []byte) (int, error) {
	c.decide(http.StatusOK)
	if c.gz != nil {
		return c.gz.Write(b)
	}
	return c.ResponseWriter.Write(b)
}

func (c *compressWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// close flushes the gzip member; call it after the wrapped handler returns.
func (c *compressWriter) close() {
	if c.gz != nil {
		_ = c.gz.Close()
		gzPool.Put(c.gz)
		c.gz = nil
	}
}

// staticGzip compresses static assets (HTML/CSS/JS/SVG) based on the response
// Content-Type. Range requests bypass compression: serveContent cannot combine
// byte ranges with a transformed body.
func staticGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept-Encoding")
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressWriter{ResponseWriter: w, head: r.Method == http.MethodHead}
		defer cw.close()
		next.ServeHTTP(cw, r)
	})
}

// bodyBuffer records a handler's status and body without touching the client,
// so the response can be validated (ETag) before it is written.
type bodyBuffer struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bodyBuffer) Header() http.Header { return b.header }

func (b *bodyBuffer) WriteHeader(code int) {
	if b.status == 0 {
		b.status = code
	}
}

func (b *bodyBuffer) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}

// weakETag hashes the uncompressed body; 8 bytes keep headers short while
// making collisions unlikely for a dataset of stations.
func weakETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `W/"` + hex.EncodeToString(sum[:8]) + `"`
}

// etagMatches applies the weak comparison from RFC 9110 §13.1.2: any listed
// entity tag (with or without the W/ prefix) or "*" matches.
func etagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		tag := strings.TrimSpace(part)
		if tag == "*" || strings.TrimPrefix(tag, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

// jsonResponse buffers a JSON API response to set a weak ETag on GET 200s,
// answer revalidations with 304, and gzip the body when the client accepts it.
// Non-GET and non-200 responses pass through unchanged (still compressed).
// Never wrap SSE or stream endpoints with it.
func jsonResponse(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b := &bodyBuffer{header: w.Header()}
		next(b, r)
		if b.status == 0 {
			b.status = http.StatusOK
		}
		body := b.body.Bytes()
		h := w.Header()
		// HEAD is GET without a body; it deserves the same validator.
		isGET := r.Method == http.MethodGet || r.Method == http.MethodHead

		if isGET && b.status == http.StatusOK {
			etag := weakETag(body)
			h.Set("ETag", etag)
			h.Set("Cache-Control", "no-cache")
			if etagMatches(r.Header.Get("If-None-Match"), etag) {
				h.Del("Content-Length")
				h.Del("Content-Encoding")
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}

		if b.status == http.StatusNoContent || b.status == http.StatusNotModified {
			h.Del("Content-Length")
			w.WriteHeader(b.status)
			return
		}
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.Set("Content-Encoding", "gzip")
			h.Add("Vary", "Accept-Encoding")
			h.Del("Content-Length")
			w.WriteHeader(b.status)
			if r.Method == http.MethodHead {
				return
			}
			gz := gzPool.Get().(*gzip.Writer)
			gz.Reset(w)
			_, _ = gz.Write(body)
			_ = gz.Close()
			gzPool.Put(gz)
			return
		}
		h.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(b.status)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(body)
	}
}
