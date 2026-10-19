package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"hotfm/server/internal/api"
	"hotfm/server/internal/catalog"
	"hotfm/server/internal/config"
	"hotfm/server/internal/health"
	"hotfm/server/internal/logo"
	"hotfm/server/internal/netguard"
	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
	"hotfm/server/internal/stream"
	"hotfm/server/internal/webui"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()}))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func logLevel() slog.Level {
	if os.Getenv("HOTFM_DEBUG") == "1" {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}
	db, err := store.Open(filepath.Join(cfg.DataDir, "hotfm.db"))
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	upstream := netguard.NewClient(netguard.Options{})
	rb := radiobrowser.New(cfg.UserAgent, cfg.RadioBrowserURL)
	hub := stream.NewHub()

	checker := &health.Checker{
		Store:       db,
		Prober:      &health.Prober{Client: upstream, UserAgent: cfg.UserAgent},
		Policy:      health.DefaultPolicy,
		Concurrency: 16,
		Log:         log.With("component", "health"),
	}
	proxy := &stream.Proxy{
		Client:    upstream,
		Hub:       hub,
		Signer:    stream.Signer{Secret: cfg.Secret, TTL: 6 * time.Hour},
		UserAgent: cfg.UserAgent,
		Log:       log.With("component", "stream"),
		Limit:     &stream.IPLimiter{Max: cfg.MaxStreamsPerIP},
		OnHealthy: func(id string) { go checker.ReportPlaying(id) },
		OnFailure: func(id string, _ error) { go checker.ReportFailure(id) },
	}
	syncer := &catalog.Syncer{
		Store:    db,
		Client:   rb,
		Interval: cfg.SyncInterval,
		Log:      log.With("component", "sync"),
		OnSynced: func(string) { checker.Wake() },
	}
	srv := api.New(api.Deps{
		Config: cfg, Store: db, Proxy: proxy, Hub: hub,
		Logos:   &logo.Cache{Dir: filepath.Join(cfg.DataDir, "logos"), Client: upstream, UserAgent: cfg.UserAgent},
		Checker: checker, Radio: rb, Log: log,
	})

	go syncer.Run(ctx)
	go checker.Run(ctx)
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				hub.Sweep(10 * time.Minute)
			}
		}
	}()

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(webui.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// Request contexts derive from ctx so a shutdown ends open streams promptly.
		BaseContext: func(net.Listener) context.Context { return ctx },
		// No WriteTimeout: audio streams and SSE are long-lived.
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "data", cfg.DataDir, "streamMode", cfg.StreamMode)
		errc <- httpSrv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutdownCtx)
}
