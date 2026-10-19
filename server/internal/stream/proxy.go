package stream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"hotfm/server/internal/store"
)

const (
	maxPlaylistBytes = 1 << 20
	maxSegmentBytes  = 64 << 20
	// healthyAfter is how many audio bytes a proxied stream must deliver to count as a passive health success.
	healthyAfter = 64 << 10
	// idleTimeout ends a relay whose upstream stopped sending audio.
	idleTimeout = 30 * time.Second
)

// Proxy serves audio streams and HLS resources for catalog stations only;
// it never fetches arbitrary client-supplied URLs.
type Proxy struct {
	Client    *http.Client
	Hub       *Hub
	Signer    Signer
	UserAgent string
	Log       *slog.Logger
	Limit     *IPLimiter
	// OnHealthy / OnFailure feed passive signals into the health checker.
	OnHealthy func(stationID string)
	OnFailure func(stationID string, err error)
}

// Error is returned to the client as a short machine-readable code.
type Error struct {
	Status int
	Code   string
	Err    error
}

func (e *Error) Error() string { return e.Code + ": " + e.Err.Error() }

func upstreamErr(code string, err error) *Error {
	return &Error{Status: http.StatusBadGateway, Code: code, Err: err}
}

func (p *Proxy) fetch(ctx context.Context, target string, icy bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, upstreamErr("bad_url", err)
	}
	req.Header.Set("User-Agent", p.UserAgent)
	req.Header.Set("Accept", "*/*")
	if icy {
		req.Header.Set("Icy-MetaData", "1")
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return nil, upstreamErr("upstream_unreachable", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		resp.Body.Close()
		return nil, upstreamErr("upstream_status", fmt.Errorf("status %d", resp.StatusCode))
	}
	return resp, nil
}

func contentTypeFor(st *store.Station, upstream string) string {
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(upstream, ";", 2)[0]))
	if strings.HasPrefix(ct, "audio/") || ct == "application/ogg" {
		if ct == "audio/aacp" || ct == "audio/x-aac" {
			return "audio/aac"
		}
		return ct
	}
	switch {
	case strings.HasPrefix(st.Codec, "AAC"):
		return "audio/aac"
	case st.Codec == "OGG":
		return "audio/ogg"
	default:
		return "audio/mpeg"
	}
}

// ServeAudio relays an Icecast/Shoutcast stream. When sid is set, ICY titles
// are published to the hub for /meta subscribers of that session.
func (p *Proxy) ServeAudio(w http.ResponseWriter, r *http.Request, st *store.Station, sid string) error {
	release, ok := p.Limit.Acquire(clientKey(r))
	if !ok {
		return &Error{Status: http.StatusTooManyRequests, Code: "too_many_streams", Err: errors.New("concurrent stream limit reached")}
	}
	defer release()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	resp, err := p.fetch(ctx, st.StreamURL, true)
	if err != nil {
		p.failure(st.ID, err)
		return err
	}
	defer resp.Body.Close()
	idle := time.AfterFunc(idleTimeout, cancel)
	defer idle.Stop()

	ctype := resp.Header.Get("Content-Type")
	head := make([]byte, 512)
	n, _ := io.ReadAtLeast(resp.Body, head, 1)
	head = head[:n]
	if IsPlaylist(ctype, head) {
		return upstreamErr("is_hls", errors.New("stream is an HLS playlist"))
	}
	if strings.HasPrefix(strings.ToLower(ctype), "text/html") {
		err := upstreamErr("not_audio", fmt.Errorf("upstream returned %s", ctype))
		p.failure(st.ID, err)
		return err
	}

	var body io.Reader = io.MultiReader(bytes.NewReader(head), resp.Body)
	if mi, _ := strconv.Atoi(resp.Header.Get("icy-metaint")); mi > 0 {
		body = &MetaReader{R: body, MetaInt: mi, PreferGBK: st.Country == "CN", OnTitle: func(t string) {
			if sid != "" {
				p.Hub.Publish(sid, t)
			}
		}}
	}
	h := w.Header()
	h.Set("Content-Type", contentTypeFor(st, ctype))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	if br := resp.Header.Get("icy-br"); br != "" {
		h.Set("X-Stream-Bitrate", br)
	}
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})
	buf := make([]byte, 16<<10)
	var total int64
	reported := false
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			idle.Reset(idleTimeout)
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil // client went away
			}
			_ = rc.Flush()
			total += int64(n)
			if !reported && total >= healthyAfter {
				reported = true
				if p.OnHealthy != nil {
					p.OnHealthy(st.ID)
				}
			}
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) && r.Context().Err() == nil {
				p.Log.Debug("stream ended", "station", st.ID, "err", rerr, "bytes", total)
			}
			return nil
		}
	}
}

func (p *Proxy) failure(id string, err error) {
	if p.OnFailure != nil {
		p.OnFailure(id, err)
	}
}

// ServeHLS serves the station's root playlist (target == "") or a signed sub-resource.
func (p *Proxy) ServeHLS(w http.ResponseWriter, r *http.Request, st *store.Station, target string) error {
	root := target == ""
	if root {
		target = st.StreamURL
	}
	resp, err := p.fetch(r.Context(), target, false)
	if err != nil {
		if root {
			p.failure(st.ID, err)
		}
		return err
	}
	defer resp.Body.Close()

	ctype := resp.Header.Get("Content-Type")
	head := make([]byte, 512)
	n, _ := io.ReadAtLeast(resp.Body, head, 1)
	head = head[:n]

	if IsPlaylist(ctype, head) {
		raw, err := io.ReadAll(io.LimitReader(io.MultiReader(bytes.NewReader(head), resp.Body), maxPlaylistBytes))
		if err != nil {
			return upstreamErr("upstream_read", err)
		}
		base := resp.Request.URL // after redirects
		out := RewritePlaylist(raw, base, func(abs string) string { return p.Signer.URL(st.ID, abs) })
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(out)
		if root && p.OnHealthy != nil {
			p.OnHealthy(st.ID)
		}
		return nil
	}
	if root {
		return upstreamErr("not_hls", errors.New("station URL is not a playlist"))
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=60")
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	_, _ = w.Write(head)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, maxSegmentBytes))
	return nil
}

// VerifyTarget validates a signed HLS sub-resource request.
func (p *Proxy) VerifyTarget(stationID string, q url.Values) (string, error) {
	t, ok := p.Signer.Verify(stationID, q)
	if !ok {
		return "", &Error{Status: http.StatusForbidden, Code: "bad_token", Err: errors.New("invalid or expired token")}
	}
	return t, nil
}

// IPLimiter caps concurrent streams per client key.
type IPLimiter struct {
	Max int
	mu  sync.Mutex
	n   map[string]int
}

func (l *IPLimiter) Acquire(key string) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n == nil {
		l.n = map[string]int{}
	}
	if l.Max > 0 && l.n[key] >= l.Max {
		return nil, false
	}
	l.n[key]++
	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.n[key]--; l.n[key] <= 0 {
			delete(l.n, key)
		}
	}, true
}

type ctxKey struct{}

// WithClientKey stores the resolved client IP on the request context (set by API middleware).
func WithClientKey(r *http.Request, key string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxKey{}, key))
}

func clientKey(r *http.Request) string {
	if k, ok := r.Context().Value(ctxKey{}).(string); ok {
		return k
	}
	return r.RemoteAddr
}
