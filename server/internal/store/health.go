package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Health is the probe bookkeeping of one station.
type Health struct {
	State       string
	FailCount   int
	FirstFailAt *time.Time
	LastProbeAt *time.Time
	LastOKAt    *time.Time
	NextProbeAt time.Time
	LatencyMs   *int
	LastError   string
}

type ProbeTarget struct {
	ID        string
	StreamURL string
	HLS       bool
}

// DueForProbe returns stations whose next probe time has passed, most
// popular first so the stations people actually play are verified soonest.
func (s *Store) DueForProbe(ctx context.Context, now time.Time, limit int) ([]ProbeTarget, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, stream_url, hls FROM stations
		WHERE deleted_at IS NULL AND next_probe_at <= ?
		ORDER BY next_probe_at = 0 DESC, clicks DESC LIMIT ?`, now.Unix(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProbeTarget
	for rows.Next() {
		var t ProbeTarget
		var hls int
		if err := rows.Scan(&t.ID, &t.StreamURL, &hls); err != nil {
			return nil, err
		}
		t.HLS = hls == 1
		out = append(out, t)
	}
	return out, rows.Err()
}

func toTime(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := time.Unix(v.Int64, 0)
	return &t
}

func fromTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Unix()
}

// UpdateHealth reads a station's health, lets fn transform it and writes it back atomically.
func (s *Store) UpdateHealth(ctx context.Context, id string, fn func(*Health)) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var (
		h                    Health
		firstFail, probe, ok sql.NullInt64
		next                 int64
		latency              sql.NullInt64
	)
	err = tx.QueryRowContext(ctx, `SELECT health, fail_count, first_fail_at, last_probe_at, last_ok_at, next_probe_at, latency_ms, last_error
		FROM stations WHERE id = ?`, id).Scan(&h.State, &h.FailCount, &firstFail, &probe, &ok, &next, &latency, &h.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	h.FirstFailAt, h.LastProbeAt, h.LastOKAt = toTime(firstFail), toTime(probe), toTime(ok)
	h.NextProbeAt = time.Unix(next, 0)
	if latency.Valid {
		l := int(latency.Int64)
		h.LatencyMs = &l
	}
	fn(&h)
	var lat any
	if h.LatencyMs != nil {
		lat = *h.LatencyMs
	}
	if _, err := tx.ExecContext(ctx, `UPDATE stations SET health=?, fail_count=?, first_fail_at=?, last_probe_at=?, last_ok_at=?,
		next_probe_at=?, latency_ms=?, last_error=? WHERE id=?`,
		h.State, h.FailCount, fromTime(h.FirstFailAt), fromTime(h.LastProbeAt), fromTime(h.LastOKAt),
		h.NextProbeAt.Unix(), lat, h.LastError, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ProbeSoon pulls a station's next probe forward (e.g. after a client reports a failure).
func (s *Store) ProbeSoon(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, "UPDATE stations SET next_probe_at = min(next_probe_at, ?) WHERE id = ?", at.Unix(), id)
	return err
}

// HealthStats counts live (non-deleted) stations per health state.
func (s *Store) HealthStats(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT health, count(*) FROM stations WHERE deleted_at IS NULL GROUP BY health")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{HealthUnknown: 0, HealthOK: 0, HealthFlaky: 0, HealthDead: 0}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

// SetHLS corrects the HLS flag after a probe discovered the real stream type.
func (s *Store) SetHLS(ctx context.Context, id string, hls bool) error {
	v := 0
	if hls {
		v = 1
	}
	_, err := s.db.ExecContext(ctx, "UPDATE stations SET hls = ? WHERE id = ?", v, id)
	return err
}

// PromoteAlternate makes mirror the primary stream URL; the old primary becomes an alternate.
func (s *Store) PromoteAlternate(ctx context.Context, id, mirror string, hls bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var cur, altsRaw string
	if err := tx.QueryRowContext(ctx, "SELECT stream_url, alternates FROM stations WHERE id = ?", id).Scan(&cur, &altsRaw); err != nil {
		return err
	}
	var alts []string
	_ = json.Unmarshal([]byte(altsRaw), &alts)
	next := []string{cur}
	for _, a := range alts {
		if a != mirror && a != cur {
			next = append(next, a)
		}
	}
	b, _ := json.Marshal(next)
	v := 0
	if hls {
		v = 1
	}
	if _, err := tx.ExecContext(ctx, "UPDATE stations SET stream_url = ?, alternates = ?, hls = ? WHERE id = ?", mirror, string(b), v, id); err != nil {
		return err
	}
	return tx.Commit()
}
