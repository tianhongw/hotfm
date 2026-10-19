package stream

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var reURIAttr = regexp.MustCompile(`URI="([^"]*)"`)

// IsPlaylist reports whether a response looks like an HLS playlist.
func IsPlaylist(contentType string, head []byte) bool {
	ct := strings.ToLower(contentType)
	return strings.Contains(ct, "mpegurl") || bytes.HasPrefix(bytes.TrimLeft(head, "\xef\xbb\xbf \r\n\t"), []byte("#EXTM3U"))
}

// RewritePlaylist resolves every URI in an m3u8 against base and maps it
// through proxy, so all follow-up requests go through our server.
func RewritePlaylist(body []byte, base *url.URL, proxy func(abs string) string) []byte {
	resolve := func(ref string) string {
		u, err := base.Parse(strings.TrimSpace(ref))
		if err != nil {
			return ref
		}
		return proxy(u.String())
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		switch {
		case strings.HasPrefix(line, "#"):
			line = reURIAttr.ReplaceAllStringFunc(line, func(m string) string {
				return `URI="` + resolve(reURIAttr.FindStringSubmatch(m)[1]) + `"`
			})
		case strings.TrimSpace(line) != "":
			line = resolve(line)
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

// Signer issues and verifies tokens binding a proxied HLS resource URL to a station.
type Signer struct {
	Secret []byte
	TTL    time.Duration
}

func (s Signer) mac(stationID, target string, exp int64) string {
	h := hmac.New(sha256.New, s.Secret)
	h.Write([]byte(stationID + "\n" + target + "\n" + strconv.FormatInt(exp, 10)))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:16])
}

// URL returns the proxy path for target.
func (s Signer) URL(stationID, target string) string {
	exp := time.Now().Add(s.TTL).Unix()
	q := url.Values{"u": {target}, "e": {strconv.FormatInt(exp, 10)}, "s": {s.mac(stationID, target, exp)}}
	return "/api/v1/hls/" + url.PathEscape(stationID) + "/r?" + q.Encode()
}

// Verify checks a token and returns the target URL.
func (s Signer) Verify(stationID string, q url.Values) (string, bool) {
	target, sig := q.Get("u"), q.Get("s")
	exp, err := strconv.ParseInt(q.Get("e"), 10, 64)
	if err != nil || target == "" || time.Now().Unix() > exp {
		return "", false
	}
	return target, hmac.Equal([]byte(sig), []byte(s.mac(stationID, target, exp)))
}
