// Package radiobrowser is a small client for the community Radio Browser API
// (https://api.radio-browser.info). It discovers mirrors via DNS and fails
// over between them.
package radiobrowser

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Station mirrors the fields of the Radio Browser station object we use.
type Station struct {
	StationUUID string   `json:"stationuuid"`
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	URLResolved string   `json:"url_resolved"`
	Homepage    string   `json:"homepage"`
	Favicon     string   `json:"favicon"`
	Tags        string   `json:"tags"`
	CountryCode string   `json:"countrycode"`
	State       string   `json:"state"`
	Language    string   `json:"language"`
	Codec       string   `json:"codec"`
	Bitrate     int      `json:"bitrate"`
	HLS         int      `json:"hls"`
	LastCheckOK int      `json:"lastcheckok"`
	ClickCount  int      `json:"clickcount"`
	Votes       int      `json:"votes"`
	GeoLat      *float64 `json:"geo_lat"`
	GeoLong     *float64 `json:"geo_long"`
}

var fallbackHosts = []string{
	"de1.api.radio-browser.info",
	"de2.api.radio-browser.info",
	"fi1.api.radio-browser.info",
}

type Client struct {
	http      *http.Client
	userAgent string
	pinned    string

	mu    sync.Mutex
	hosts []string
}

// New creates a client. If pinnedBase is non-empty (e.g. "https://de1.api.radio-browser.info")
// DNS discovery is skipped.
func New(userAgent, pinnedBase string) *Client {
	return &Client{
		http:      &http.Client{Timeout: 3 * time.Minute},
		userAgent: userAgent,
		pinned:    strings.TrimRight(pinnedBase, "/"),
	}
}

// bases returns mirror base URLs in the order they should be tried.
func (c *Client) bases(ctx context.Context) []string {
	if c.pinned != "" {
		return []string{c.pinned}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hosts == nil {
		c.hosts = discover(ctx)
	}
	out := make([]string, len(c.hosts))
	for i, h := range c.hosts {
		out[i] = "https://" + h
	}
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// discover resolves all.api.radio-browser.info and reverse-resolves each IP
// to its mirror hostname, as recommended by the Radio Browser docs.
func discover(ctx context.Context) []string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupHost(ctx, "all.api.radio-browser.info")
	if err != nil {
		return fallbackHosts
	}
	seen := map[string]bool{}
	var hosts []string
	for _, ip := range ips {
		names, err := net.DefaultResolver.LookupAddr(ctx, ip)
		if err != nil {
			continue
		}
		for _, n := range names {
			n = strings.TrimSuffix(n, ".")
			if strings.HasSuffix(n, ".api.radio-browser.info") && !seen[n] {
				seen[n] = true
				hosts = append(hosts, n)
			}
		}
	}
	for _, h := range fallbackHosts {
		if !seen[h] {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

func (c *Client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	var lastErr error
	for _, base := range c.bases(ctx) {
		u := base + path
		if len(q) > 0 {
			u += "?" + q.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", c.userAgent)
		req.Header.Set("Accept", "application/json")
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		err = func() error {
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("%s: status %d", u, resp.StatusCode)
			}
			return json.NewDecoder(resp.Body).Decode(out)
		}()
		if err == nil {
			return nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no radio-browser mirrors available")
	}
	return lastErr
}

// StationsByCountry pages through all working stations of a country, most popular first.
func (c *Client) StationsByCountry(ctx context.Context, countryCode string) ([]Station, error) {
	const page = 500
	var all []Station
	for offset := 0; ; offset += page {
		q := url.Values{
			"countrycode": {countryCode},
			"hidebroken":  {"true"},
			"order":       {"clickcount"},
			"reverse":     {"true"},
			"limit":       {strconv.Itoa(page)},
			"offset":      {strconv.Itoa(offset)},
		}
		var batch []Station
		if err := c.getJSON(ctx, "/json/stations/search", q, &batch); err != nil {
			return nil, fmt.Errorf("fetch %s offset %d: %w", countryCode, offset, err)
		}
		all = append(all, batch...)
		if len(batch) < page {
			return all, nil
		}
	}
}

// Click registers a play with Radio Browser so its popularity ranking stays meaningful.
func (c *Client) Click(ctx context.Context, stationUUID string) error {
	var out struct {
		OK bool `json:"ok"`
	}
	return c.getJSON(ctx, "/json/url/"+url.PathEscape(stationUUID), nil, &out)
}
