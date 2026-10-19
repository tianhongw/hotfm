package health

import (
	"testing"
	"time"

	"hotfm/server/internal/store"
)

func TestPolicyTransitions(t *testing.T) {
	p := DefaultPolicy
	t0 := time.Unix(1_700_000_000, 0)
	h := &store.Health{State: store.HealthUnknown}

	p.Apply(h, true, 120*time.Millisecond, "", t0)
	if h.State != store.HealthOK || h.LatencyMs == nil || *h.LatencyMs != 120 || h.NextProbeAt.Sub(t0) < p.OKInterval {
		t.Fatalf("after success: %+v", h)
	}

	// First failure: flaky, short backoff.
	p.Apply(h, false, 0, "timeout", t0.Add(time.Hour))
	if h.State != store.HealthFlaky || h.FailCount != 1 || h.LastError != "timeout" {
		t.Fatalf("after 1 fail: %+v", h)
	}
	if d := h.NextProbeAt.Sub(t0.Add(time.Hour)); d < 30*time.Minute || d > 34*time.Minute {
		t.Fatalf("backoff after 1 fail = %v", d)
	}

	// Three quick failures are not enough: the failures must span DeadAfterSpan.
	p.Apply(h, false, 0, "timeout", t0.Add(2*time.Hour))
	p.Apply(h, false, 0, "timeout", t0.Add(3*time.Hour))
	if h.State != store.HealthFlaky || h.FailCount != 3 {
		t.Fatalf("3 fails within span should stay flaky: %+v", h)
	}
	p.Apply(h, false, 0, "timeout", t0.Add(14*time.Hour))
	if h.State != store.HealthDead {
		t.Fatalf("expected dead: %+v", h)
	}
	if d := h.NextProbeAt.Sub(t0.Add(14 * time.Hour)); d < p.DeadInterval {
		t.Fatalf("dead re-check interval = %v", d)
	}

	// A dead station that plays again is revived.
	p.Apply(h, true, 0, "", t0.Add(40*time.Hour))
	if h.State != store.HealthOK || h.FailCount != 0 || h.FirstFailAt != nil || h.LastError != "" {
		t.Fatalf("expected revival: %+v", h)
	}
}

func TestBackoffCapped(t *testing.T) {
	p := DefaultPolicy
	p.DeadAfterFails = 100
	h := &store.Health{}
	now := time.Unix(0, 0)
	for range 10 {
		p.Apply(h, false, 0, "x", now)
	}
	last := p.Backoff[len(p.Backoff)-1]
	if d := h.NextProbeAt.Sub(now); d < last || d > last+last/10 {
		t.Fatalf("capped backoff = %v", d)
	}
}
