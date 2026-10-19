// Package netguard builds HTTP clients that only talk to public internet
// hosts (SSRF protection) and understand legacy Shoutcast "ICY 200 OK" replies.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

var ErrBlockedAddress = errors.New("destination address not allowed")

// IsPublic reports whether ip is a globally routable unicast address.
func IsPublic(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
}

// control runs after DNS resolution for every connection attempt, including
// redirects, so DNS rebinding cannot reach internal hosts.
func control(allowPrivate bool) func(network, address string, _ syscall.RawConn) error {
	return func(network, address string, _ syscall.RawConn) error {
		if allowPrivate {
			return nil
		}
		ap, err := netip.ParseAddrPort(address)
		if err != nil {
			return fmt.Errorf("%w: %s", ErrBlockedAddress, address)
		}
		if !IsPublic(ap.Addr()) {
			return fmt.Errorf("%w: %s", ErrBlockedAddress, ap.Addr())
		}
		return nil
	}
}

type Options struct {
	ResponseHeaderTimeout time.Duration
	// AllowPrivate disables the address check; only for tests against httptest servers.
	AllowPrivate bool
}

// NewClient returns a client without an overall timeout (streams are endless);
// callers bound requests with contexts.
func NewClient(o Options) *http.Client {
	if o.ResponseHeaderTimeout == 0 {
		o.ResponseHeaderTimeout = 15 * time.Second
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second, Control: control(o.AllowPrivate)}
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return &icyConn{Conn: c}, nil
		},
		ForceAttemptHTTP2:     false, // radio servers are HTTP/1.x; ICY fix-up needs the raw conn
		MaxIdleConns:          64,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: o.ResponseHeaderTimeout,
		DisableCompression:    true,
	}
	return &http.Client{
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("redirect to unsupported scheme %q", req.URL.Scheme)
			}
			return nil
		},
	}
}

// icyConn rewrites a leading "ICY " status line (Shoutcast v1) to "HTTP/1.0 "
// so net/http can parse the response. TLS bytes never start with "ICY ".
type icyConn struct {
	net.Conn
	checked bool
	pending []byte
}

func (c *icyConn) Read(p []byte) (int, error) {
	if !c.checked {
		c.checked = true
		head := make([]byte, 4)
		n, err := io.ReadFull(c.Conn, head)
		if n == 4 && string(head) == "ICY " {
			c.pending = []byte("HTTP/1.0 ")
		} else {
			c.pending = head[:n]
		}
		if n == 0 && err != nil {
			return 0, err
		}
	}
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}
