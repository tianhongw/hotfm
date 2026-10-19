package api

import (
	"compress/gzip"
	"net"
	"net/http"
	"runtime/debug"
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

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

var gzPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed); return w }}

// gzipped compresses JSON responses; never wrap streaming endpoints with it.
func gzipped(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next(w, r)
			return
		}
		gz := gzPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			gz.Close()
			gzPool.Put(gz)
		}()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		next(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	}
}
