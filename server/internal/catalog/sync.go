package catalog

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

// Countries is the fixed scope of the app.
var Countries = []string{"US", "CN"}

// purgeAfter is how long a station may stay gone upstream or dead before it is deleted for good.
const purgeAfter = 30 * 24 * time.Hour

// pollInterval is how often Run wakes up to re-check staleness when nothing is due.
const pollInterval = time.Hour

// minWait is the shortest time Run sleeps between passes; var so tests can shrink it.
var minWait = time.Second

// retryLadder is the wait after n consecutive failed runs; beyond the ladder the
// normal Interval applies. var (not const) so tests can shrink it.
var retryLadder = []time.Duration{time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 30 * time.Minute}

// retryDelay returns the wait before retrying after n consecutive failures.
func retryDelay(n int, interval time.Duration) time.Duration {
	if n <= 0 {
		return 0
	}
	d := interval
	if n <= len(retryLadder) {
		d = retryLadder[n-1]
	}
	if interval > 0 && d > interval {
		d = interval // never slower than the normal cadence
	}
	return d
}

// syncState is the process-local status of one country's syncs.
type syncState struct {
	running  bool
	failures int
	retryAt  time.Time
}

type Syncer struct {
	Store    *store.Store
	Client   *radiobrowser.Client
	Interval time.Duration
	Log      *slog.Logger
	// OnSynced is called after a country finished syncing (e.g. to kick the health checker).
	OnSynced func(country string)

	mu    sync.Mutex
	state map[string]*syncState
}

// Syncing reports whether a sync run is in flight for country.
func (s *Syncer) Syncing(country string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.state[country]
	return st != nil && st.running
}

// countryState returns the mutable state of country; the caller holds s.mu.
func (s *Syncer) countryState(country string) *syncState {
	if s.state == nil {
		s.state = map[string]*syncState{}
	}
	st := s.state[country]
	if st == nil {
		st = &syncState{}
		s.state[country] = st
	}
	return st
}

func (s *Syncer) setRunning(country string, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.countryState(country).running = on
}

// retryUntil returns the time a failed country may be retried at.
func (s *Syncer) retryUntil(country string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.state[country]
	if st == nil || st.retryAt.IsZero() {
		return time.Time{}, false
	}
	return st.retryAt, true
}

// noteFailure records a failed run and returns the wait before the next attempt.
func (s *Syncer) noteFailure(country string) time.Duration {
	s.mu.Lock()
	st := s.countryState(country)
	st.failures++
	n := st.failures
	d := retryDelay(n, s.Interval)
	st.retryAt = time.Now().Add(d)
	s.mu.Unlock()
	s.Log.Warn("sync retry scheduled", "country", country, "attempt", n, "retryIn", d)
	return d
}

func (s *Syncer) clearFailure(country string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.state[country]; st != nil {
		st.failures, st.retryAt = 0, time.Time{}
	}
}

// Run syncs every country whose data is older than Interval, then re-checks
// hourly. Checking staleness instead of using a plain ticker means restarts
// neither skip nor duplicate syncs. A failed run is retried on the retry
// ladder (a minute at first, backing off up to Interval) so a fresh install
// recovers from an upstream hiccup without waiting for the next hourly pass.
func (s *Syncer) Run(ctx context.Context) {
	lastPurge := time.Time{}
	for {
		wait := pollInterval
		for _, c := range Countries {
			if until, pending := s.retryUntil(c); pending {
				if d := time.Until(until); d > 0 {
					if d < wait {
						wait = d
					}
					continue
				}
			}
			last, err := s.Store.LastSuccessfulSync(ctx, c)
			if err != nil {
				s.Log.Error("read sync state", "country", c, "err", err)
				continue
			}
			if time.Since(last) < s.Interval {
				continue
			}
			if err := s.SyncCountry(ctx, c); err != nil {
				if ctx.Err() != nil {
					return
				}
				s.Log.Error("sync failed", "country", c, "err", err)
				if d := s.noteFailure(c); d < wait {
					wait = d
				}
			} else {
				s.clearFailure(c)
			}
		}
		// Purging is throttled: the retry ladder can wake Run every minute.
		if time.Since(lastPurge) >= pollInterval {
			lastPurge = time.Now()
			if n, err := s.Store.Purge(ctx, time.Now(), purgeAfter); err != nil {
				s.Log.Error("purge", "err", err)
			} else if n > 0 {
				s.Log.Info("purged stale stations", "count", n)
			}
		}
		if wait < minWait {
			wait = minWait
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (s *Syncer) SyncCountry(ctx context.Context, country string) (err error) {
	s.setRunning(country, true)
	defer s.setRunning(country, false)
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
	existing, err := s.Store.ExistingIDs(ctx, country)
	if err != nil {
		return err
	}
	stations := Convert(country, raw, keep, existing)
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
