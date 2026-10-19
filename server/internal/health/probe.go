// Package health continuously verifies that catalog streams actually play,
// hides dead ones and fails over to working mirrors.
package health

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"hotfm/server/internal/stream"
)

// Result of probing one stream URL.
type Result struct {
	OK      bool
	Latency time.Duration // time to first byte
	Err     string
	IsHLS   bool // the URL turned out to be an HLS playlist
}

type Prober struct {
	Client    *http.Client
	UserAgent string
	Timeout   time.Duration
}

const (
	minAudioBytes = 2 << 10
	readBytes     = 32 << 10
)

// Probe fetches the beginning of a stream and checks it is real audio (or a
// valid HLS playlist whose first segment downloads).
func (p *Prober) Probe(ctx context.Context, target string) Result {
	timeout := p.Timeout
	if timeout == 0 {
		timeout = 12 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	start := time.Now()
	resp, err := p.get(ctx, target)
	if err != nil {
		return fail(err)
	}
	defer resp.Body.Close()
	latency := time.Since(start)

	head, err := io.ReadAll(io.LimitReader(resp.Body, readBytes))
	if len(head) == 0 && err != nil {
		return fail(fmt.Errorf("read: %w", err))
	}
	ctype := resp.Header.Get("Content-Type")
	if stream.IsPlaylist(ctype, head) {
		if err := p.checkHLS(ctx, resp.Request.URL, head, 0); err != nil {
			return Result{Latency: latency, Err: err.Error(), IsHLS: true}
		}
		return Result{OK: true, Latency: latency, IsHLS: true}
	}
	if err := checkAudio(ctype, head); err != nil {
		return Result{Latency: latency, Err: err.Error()}
	}
	return Result{OK: true, Latency: latency}
}

func fail(err error) Result {
	msg := err.Error()
	if errors.Is(err, context.DeadlineExceeded) {
		msg = "timeout"
	}
	return Result{Err: msg}
}

func (p *Prober) get(ctx context.Context, target string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", p.UserAgent)
	resp, err := p.Client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		resp.Body.Close()
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return resp, nil
}

// checkAudio accepts declared audio types, or untyped bodies that start with
// a known audio container / frame signature.
func checkAudio(ctype string, b []byte) error {
	ct := strings.ToLower(ctype)
	if strings.HasPrefix(ct, "text/") || strings.Contains(ct, "html") || strings.Contains(ct, "json") {
		return fmt.Errorf("not audio (%s)", strings.SplitN(ct, ";", 2)[0])
	}
	if len(b) < minAudioBytes {
		return fmt.Errorf("stream too short (%d bytes)", len(b))
	}
	if strings.HasPrefix(ct, "audio/") || ct == "application/ogg" || strings.HasPrefix(ct, "video/mp2t") {
		return nil
	}
	if looksLikeAudio(b) {
		return nil
	}
	return fmt.Errorf("unrecognised content (%s)", ct)
}

func looksLikeAudio(b []byte) bool {
	switch {
	case bytes.HasPrefix(b, []byte("ID3")), bytes.HasPrefix(b, []byte("OggS")), bytes.HasPrefix(b, []byte("fLaC")):
		return true
	}
	// MPEG audio / ADTS frame sync somewhere in the first KB (streams may start mid-frame).
	for i := 0; i+1 < len(b) && i < 1024; i++ {
		if b[i] == 0xFF && b[i+1]&0xE0 == 0xE0 {
			return true
		}
	}
	return false
}

// checkHLS follows a master playlist to a media playlist and downloads the
// start of its first segment.
func (p *Prober) checkHLS(ctx context.Context, base *url.URL, playlist []byte, depth int) error {
	if depth > 2 {
		return errors.New("playlist nesting too deep")
	}
	var first string
	isMaster := bytes.Contains(playlist, []byte("#EXT-X-STREAM-INF"))
	sc := bufio.NewScanner(bytes.NewReader(playlist))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" && !strings.HasPrefix(line, "#") {
			first = line
			break
		}
	}
	if first == "" {
		return errors.New("empty playlist")
	}
	u, err := base.Parse(first)
	if err != nil {
		return fmt.Errorf("bad playlist entry: %w", err)
	}
	resp, err := p.get(ctx, u.String())
	if err != nil {
		return fmt.Errorf("hls: %w", err)
	}
	defer resp.Body.Close()
	head, _ := io.ReadAll(io.LimitReader(resp.Body, readBytes))
	if isMaster || stream.IsPlaylist(resp.Header.Get("Content-Type"), head) {
		return p.checkHLS(ctx, resp.Request.URL, head, depth+1)
	}
	if len(head) < 188 {
		return errors.New("hls segment too short")
	}
	return nil
}
