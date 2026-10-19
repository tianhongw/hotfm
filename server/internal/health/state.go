package health

import (
	"math/rand/v2"
	"time"

	"hotfm/server/internal/store"
)

// Policy holds the timing of the health state machine:
//
//	unknown/ok --fail--> flaky --(>= DeadAfterFails fails spanning >= DeadAfterSpan)--> dead
//	any state --success--> ok
type Policy struct {
	OKInterval     time.Duration   // re-probe period for healthy stations
	Backoff        []time.Duration // re-probe delays after the 1st, 2nd, ... consecutive failure
	DeadAfterFails int
	DeadAfterSpan  time.Duration
	DeadInterval   time.Duration // dead stations are still re-checked so they can come back
}

var DefaultPolicy = Policy{
	OKInterval:     12 * time.Hour,
	Backoff:        []time.Duration{30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour},
	DeadAfterFails: 3,
	DeadAfterSpan:  12 * time.Hour,
	DeadInterval:   24 * time.Hour,
}

// jitter spreads probes so stations synced together are not re-probed in one burst.
func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d/10)+1))
}

// Apply records a probe outcome on h.
func (p Policy) Apply(h *store.Health, ok bool, latency time.Duration, errMsg string, now time.Time) {
	h.LastProbeAt = &now
	if ok {
		h.State = store.HealthOK
		h.FailCount = 0
		h.FirstFailAt = nil
		h.LastOKAt = &now
		h.LastError = ""
		if latency > 0 {
			ms := int(latency.Milliseconds())
			h.LatencyMs = &ms
		}
		h.NextProbeAt = now.Add(jitter(p.OKInterval))
		return
	}
	h.FailCount++
	h.LastError = errMsg
	if h.FirstFailAt == nil {
		h.FirstFailAt = &now
	}
	if h.FailCount >= p.DeadAfterFails && now.Sub(*h.FirstFailAt) >= p.DeadAfterSpan {
		h.State = store.HealthDead
		h.NextProbeAt = now.Add(jitter(p.DeadInterval))
		return
	}
	h.State = store.HealthFlaky
	i := min(h.FailCount-1, len(p.Backoff)-1)
	h.NextProbeAt = now.Add(jitter(p.Backoff[i]))
}
