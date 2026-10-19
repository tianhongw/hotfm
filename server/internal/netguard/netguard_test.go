package netguard

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestIsPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8": true, "91.98.4.78": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.1.2.3": false, "172.16.0.1": false, "192.168.1.1": false,
		"169.254.169.254": false, "100.64.0.1": false, "0.0.0.0": false, "::1": false,
		"fe80::1": false, "fc00::1": false, "::ffff:127.0.0.1": false,
	} {
		if got := IsPublic(netip.MustParseAddr(addr)); got != want {
			t.Errorf("IsPublic(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestClientBlocksLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	_, err := NewClient(Options{}).Get(srv.URL)
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("expected blocked address error, got %v", err)
	}
}

// control runs for every dial, redirects included, so checking it covers redirect-to-private too.
func TestControl(t *testing.T) {
	if err := control(false)("tcp", "127.0.0.1:80", nil); !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("control allowed loopback: %v", err)
	}
	if err := control(false)("tcp", "[::ffff:10.0.0.1]:80", nil); !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("control allowed mapped private: %v", err)
	}
	if err := control(false)("tcp", "8.8.8.8:443", nil); err != nil {
		t.Fatalf("control blocked public: %v", err)
	}
}

func TestICYStatusLine(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		bufio.NewReader(c).ReadString('\n')
		io.WriteString(c, "ICY 200 OK\r\nicy-name:Test\r\nContent-Type: audio/mpeg\r\nicy-metaint:8192\r\n\r\nAUDIO")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+ln.Addr().String()+"/", nil)
	resp, err := NewClient(Options{AllowPrivate: true}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || resp.Header.Get("icy-metaint") != "8192" || string(body) != "AUDIO" {
		t.Fatalf("status=%d metaint=%q body=%q", resp.StatusCode, resp.Header.Get("icy-metaint"), body)
	}
}
