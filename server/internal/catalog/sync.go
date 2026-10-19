package catalog

import (
	"context"
	"log/slog"
	"time"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

// Countries is the fixed scope of the app.
var Countries = []string{"US", "CN"}

// purgeAfter is how long a station may stay gone upstream or dead before it is deleted for good.
const purgeAfter = 30 * 24 * time.Hour

type Syncer struct {
	Store    *store.Store
	Client   *radiobrowser.Client
	Interval time.Duration
	Log      *slog.Logger
	// OnSynced is called after a country finished syncing (e.g. to kick the health checker).
	OnSynced func(country string)
}

// Run syncs every country whose data is older than Interval, then re-checks
// hourly. Checking staleness instead of using a plain ticker means restarts
// neither skip nor duplicate syncs.
func (s *Syncer) Run(ctx context.Context) {
	for {
		for _, c := range Countries {
			last, err := s.Store.LastSuccessfulSync(ctx, c)
			if err != nil {
				s.Log.Error("read sync state", "country", c, "err", err)
				continue
			}
			if time.Since(last) < s.Interval {
				continue
			}
			if err := s.SyncCountry(ctx, c); err != nil && ctx.Err() == nil {
				s.Log.Error("sync failed", "country", c, "err", err)
			}
		}
		if n, err := s.Store.Purge(ctx, time.Now(), purgeAfter); err != nil {
			s.Log.Error("purge", "err", err)
		} else if n > 0 {
			s.Log.Info("purged stale stations", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Hour):
		}
	}
}

func (s *Syncer) SyncCountry(ctx context.Context, country string) (err error) {
	started := time.Now()
	runID, err := s.Store.StartSyncRun(ctx, country, started)
	if err != nil {
		return err
	}
	var fetched, kept, removed int
	defer func() {
		if ferr := s.Store.FinishSyncRun(context.WithoutCancel(ctx), runID, fetched, kept, removed, err, time.Now()); ferr != nil {
			s.Log.Error("record sync run", "err", ferr)
		}
	}()

	s.Log.Info("sync started", "country", country)
	raw, err := s.Client.StationsByCountry(ctx, country)
	if err != nil {
		return err
	}
	fetched = len(raw)
	keep, err := s.Store.StreamURLs(ctx, country)
	if err != nil {
		return err
	}
	stations := Convert(country, raw, keep)
	kept = len(stations)
	removed, err = s.Store.ReplaceCountry(ctx, country, stations, time.Now())
	if err != nil {
		return err
	}
	s.Log.Info("sync finished", "country", country, "fetched", fetched, "kept", kept, "removed", removed, "took", time.Since(started).Round(time.Millisecond))
	if s.OnSynced != nil {
		s.OnSynced(country)
	}
	return nil
}
