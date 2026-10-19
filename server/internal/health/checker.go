package health

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"hotfm/server/internal/store"
)

// Checker runs the probe loop.
type Checker struct {
	Store       *store.Store
	Prober      *Prober
	Policy      Policy
	Concurrency int
	Log         *slog.Logger

	wake      chan struct{}
	once      sync.Once
	probed    atomic.Int64
	lastRound atomic.Int64 // unix seconds of the last time the due queue was drained

	passiveMu sync.Mutex
	passive   map[string]time.Time
}

func (c *Checker) init() {
	c.once.Do(func() {
		c.wake = make(chan struct{}, 1)
		c.passive = map[string]time.Time{}
		if c.Concurrency <= 0 {
			c.Concurrency = 16
		}
	})
}

// Wake makes the loop look for due stations immediately (after a sync or a client report).
func (c *Checker) Wake() {
	c.init()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

type Stats struct {
	Probed    int64
	LastDrain time.Time
}

func (c *Checker) Stats() Stats {
	return Stats{Probed: c.probed.Load(), LastDrain: time.Unix(c.lastRound.Load(), 0)}
}

func (c *Checker) Run(ctx context.Context) {
	c.init()
	for {
		targets, err := c.Store.DueForProbe(ctx, time.Now(), 256)
		if err != nil && ctx.Err() == nil {
			c.Log.Error("load probe queue", "err", err)
		}
		if len(targets) == 0 {
			c.lastRound.Store(time.Now().Unix())
			select {
			case <-ctx.Done():
				return
			case <-c.wake:
			case <-time.After(time.Minute):
			}
			continue
		}
		c.probeAll(ctx, targets)
		if ctx.Err() != nil {
			return
		}
	}
}

func (c *Checker) probeAll(ctx context.Context, targets []store.ProbeTarget) {
	jobs := make(chan store.ProbeTarget)
	var wg sync.WaitGroup
	for range c.Concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				c.check(ctx, t)
			}
		}()
	}
	for _, t := range targets {
		select {
		case jobs <- t:
		case <-ctx.Done():
		}
	}
	close(jobs)
	wg.Wait()
}

func (c *Checker) check(ctx context.Context, t store.ProbeTarget) {
	res := c.Prober.Probe(ctx, t.StreamURL)
	if ctx.Err() != nil {
		return
	}
	c.probed.Add(1)
	now := time.Now()
	var h store.Health
	err := c.Store.UpdateHealth(ctx, t.ID, func(cur *store.Health) {
		c.Policy.Apply(cur, res.OK, res.Latency, res.Err, now)
		h = *cur
	})
	if err != nil {
		c.Log.Error("record probe", "station", t.ID, "err", err)
		return
	}
	if res.OK && res.IsHLS != t.HLS {
		_ = c.Store.SetHLS(ctx, t.ID, res.IsHLS)
	}
	// From the second consecutive failure on, try the station's mirrors.
	if !res.OK && h.FailCount >= 2 {
		c.failover(ctx, t.ID)
	}
}

// failover probes alternates and promotes the first working one.
func (c *Checker) failover(ctx context.Context, id string) {
	st, err := c.Store.GetStation(ctx, id)
	if err != nil || len(st.Alternates) == 0 {
		return
	}
	for _, alt := range st.Alternates {
		res := c.Prober.Probe(ctx, alt)
		if !res.OK {
			continue
		}
		if err := c.Store.PromoteAlternate(ctx, id, alt, res.IsHLS); err != nil {
			c.Log.Error("promote alternate", "station", id, "err", err)
			return
		}
		now := time.Now()
		_ = c.Store.UpdateHealth(ctx, id, func(h *store.Health) { c.Policy.Apply(h, true, res.Latency, "", now) })
		c.Log.Info("failed over to mirror", "station", id, "url", alt)
		return
	}
}

// ReportPlaying records a passive success from a proxied stream that delivered audio.
// It is throttled so busy stations do not hammer the database.
func (c *Checker) ReportPlaying(id string) {
	c.init()
	c.passiveMu.Lock()
	if last, ok := c.passive[id]; ok && time.Since(last) < time.Hour {
		c.passiveMu.Unlock()
		return
	}
	c.passive[id] = time.Now()
	if len(c.passive) > 10000 {
		c.passive = map[string]time.Time{}
	}
	c.passiveMu.Unlock()
	now := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.Store.UpdateHealth(ctx, id, func(h *store.Health) { c.Policy.Apply(h, true, 0, "", now) })
}

// ReportFailure schedules a prompt re-probe. A single client failure is not
// trusted as a verdict by itself (it may be the listener's network).
func (c *Checker) ReportFailure(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Store.ProbeSoon(ctx, id, time.Now()); err == nil {
		c.Wake()
	}
}
