// Package config loads runtime settings from environment variables.
package config

import (
	"crypto/rand"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr            string        // HOTFM_ADDR
	DataDir         string        // HOTFM_DATA_DIR
	SyncInterval    time.Duration // HOTFM_SYNC_INTERVAL
	UserAgent       string        // HOTFM_USER_AGENT
	Secret          []byte        // HOTFM_SECRET, signs HLS proxy URLs
	StreamMode      string        // HOTFM_STREAM_MODE: proxy | auto
	MaxStreamsPerIP int           // HOTFM_MAX_STREAMS_PER_IP
	TrustProxy      bool          // HOTFM_TRUST_PROXY: honour X-Forwarded-For
	RadioBrowserURL string        // HOTFM_RADIOBROWSER_URL: pin one mirror instead of DNS discovery
	DevCORS         bool          // HOTFM_DEV_CORS
}

func Load() (*Config, error) {
	c := &Config{
		Addr:            env("HOTFM_ADDR", ":8080"),
		DataDir:         env("HOTFM_DATA_DIR", "./data"),
		UserAgent:       env("HOTFM_USER_AGENT", "HotFM/0.1 (+https://github.com/hotfm)"),
		StreamMode:      env("HOTFM_STREAM_MODE", "auto"),
		RadioBrowserURL: os.Getenv("HOTFM_RADIOBROWSER_URL"),
		TrustProxy:      os.Getenv("HOTFM_TRUST_PROXY") == "1",
		DevCORS:         os.Getenv("HOTFM_DEV_CORS") == "1",
	}
	var err error
	if c.SyncInterval, err = time.ParseDuration(env("HOTFM_SYNC_INTERVAL", "24h")); err != nil {
		return nil, fmt.Errorf("HOTFM_SYNC_INTERVAL: %w", err)
	}
	if c.MaxStreamsPerIP, err = strconv.Atoi(env("HOTFM_MAX_STREAMS_PER_IP", "4")); err != nil {
		return nil, fmt.Errorf("HOTFM_MAX_STREAMS_PER_IP: %w", err)
	}
	if c.StreamMode != "proxy" && c.StreamMode != "auto" {
		return nil, fmt.Errorf("HOTFM_STREAM_MODE must be proxy or auto, got %q", c.StreamMode)
	}
	if s := os.Getenv("HOTFM_SECRET"); s != "" {
		c.Secret = []byte(s)
	} else {
		// Ephemeral secret: signed HLS URLs simply stop validating after a restart,
		// and the player reloads the playlist.
		c.Secret = make([]byte, 32)
		if _, err := rand.Read(c.Secret); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
