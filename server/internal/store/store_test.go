package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func f(v float64) *float64 { return &v }

func TestReplaceListAndHealthVisibility(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := time.Unix(1_700_000_000, 0)
	_, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "a", Name: "KIIS FM", RegionKey: "california", RegionName: "California", Freq: f(102.7), Band: "fm", Tags: []string{"pop", "top 40"}, StreamURL: "https://a/1", Clicks: 10},
		{ID: "b", Name: "KROQ", RegionKey: "california", RegionName: "California", Freq: f(106.7), Band: "fm", Tags: []string{"rock"}, StreamURL: "https://b/1", Clicks: 20},
		{ID: "c", Name: "Groove Salad", RegionKey: "other", Band: "net", Tags: []string{"ambient"}, StreamURL: "https://c/1", Clicks: 30},
	}, now)
	if err != nil {
		t.Fatal(err)
	}

	items, total, err := s.ListStations(ctx, Query{Country: "US", Limit: 10})
	if err != nil || total != 3 || items[0].ID != "c" {
		t.Fatalf("popular list: total=%d first=%v err=%v", total, items[0].ID, err)
	}
	items, _, _ = s.ListStations(ctx, Query{Country: "US", Tag: "top 40", Limit: 10})
	if len(items) != 1 || items[0].ID != "a" {
		t.Fatalf("tag filter: %v", items)
	}
	items, _, _ = s.ListStations(ctx, Query{Country: "US", Q: "kroq", Limit: 10})
	if len(items) != 1 || items[0].ID != "b" {
		t.Fatalf("search: %v", items)
	}
	items, _, _ = s.ListStations(ctx, Query{Country: "US", Freq: f(106.7), Limit: 10})
	if len(items) != 1 || items[0].ID != "b" {
		t.Fatalf("freq filter: %v", items)
	}
	items, _, _ = s.ListStations(ctx, Query{Country: "US", Q: "50%", Limit: 10})
	if len(items) != 0 {
		t.Fatalf("LIKE wildcard not escaped: %v", items)
	}

	// Dead stations disappear from listings and the dial but stay fetchable by id.
	if err := s.UpdateHealth(ctx, "a", func(h *Health) { h.State = HealthDead }); err != nil {
		t.Fatal(err)
	}
	dial, _ := s.DialStations(ctx, "US", "california")
	if len(dial) != 1 || dial[0].ID != "b" {
		t.Fatalf("dial: %v", dial)
	}
	st, err := s.GetStation(ctx, "a")
	if err != nil || st.Visible() {
		t.Fatalf("dead station by id: %+v %v", st, err)
	}

	// Re-sync without "c": it is soft deleted; changed URL resets health of "a".
	later := now.Add(time.Hour)
	removed, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "a", Name: "KIIS FM", Band: "fm", Freq: f(102.7), StreamURL: "https://a/2"},
		{ID: "b", Name: "KROQ", Band: "fm", Freq: f(106.7), StreamURL: "https://b/1"},
	}, later)
	if err != nil || removed != 1 {
		t.Fatalf("removed=%d err=%v", removed, err)
	}
	st, _ = s.GetStation(ctx, "a")
	if st.Health != HealthUnknown || !st.Visible() {
		t.Fatalf("health not reset on url change: %+v", st)
	}
	st, _ = s.GetStation(ctx, "c")
	if st.DeletedAt == nil {
		t.Fatal("c not soft deleted")
	}

	// Purge removes long-gone rows only.
	n, err := s.Purge(ctx, later.Add(31*24*time.Hour), 30*24*time.Hour)
	if err != nil || n != 1 {
		t.Fatalf("purge n=%d err=%v", n, err)
	}
	if _, err := s.GetStation(ctx, "c"); err != ErrNotFound {
		t.Fatalf("c still present: %v", err)
	}
}

func TestPromoteAlternate(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	_, _ = s.ReplaceCountry(ctx, "CN", []Station{{ID: "x", Name: "中国之声", Band: "net", StreamURL: "https://p/1.mp3", Alternates: []string{"http://m/index.m3u8", "https://m2/a.mp3"}}}, time.Now())
	if err := s.PromoteAlternate(ctx, "x", "http://m/index.m3u8", true); err != nil {
		t.Fatal(err)
	}
	st, _ := s.GetStation(ctx, "x")
	if st.StreamURL != "http://m/index.m3u8" || !st.HLS || len(st.Alternates) != 2 || st.Alternates[0] != "https://p/1.mp3" {
		t.Fatalf("after promote: %+v", st)
	}
}
