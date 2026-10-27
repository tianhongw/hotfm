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

func TestStationAliases(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := time.Unix(1_700_000_000, 0)
	_, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "a", Name: "KEXP", RegionKey: "washington", Band: "fm", Freq: f(90.3), StreamURL: "https://a/1", AbsorbedIDs: []string{"old1", "old2", ""}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}

	st, err := s.GetStation(ctx, "old1")
	if err != nil || st.ID != "a" || st.AliasOf != "old1" {
		t.Fatalf("alias lookup: %+v %v", st, err)
	}
	if st, err := s.GetStation(ctx, "a"); err != nil || st.AliasOf != "" {
		t.Fatalf("direct lookup: %+v %v", st, err)
	}
	if _, err := s.GetStation(ctx, "nope"); err != ErrNotFound {
		t.Fatalf("unknown id: %v", err)
	}

	// Request order is preserved, aliases carry the requested id, unknown ids drop.
	items, err := s.GetStations(ctx, []string{"old2", "a", "nope"})
	if err != nil || len(items) != 2 {
		t.Fatalf("batch: %d items, %v", len(items), err)
	}
	if items[0].ID != "a" || items[0].AliasOf != "old2" || items[1].AliasOf != "" {
		t.Fatalf("batch order: %+v %+v", items[0], items[1])
	}
	// The same canonical station can answer two ids.
	items, err = s.GetStations(ctx, []string{"a", "old1"})
	if err != nil || len(items) != 2 || items[0].AliasOf != "" || items[1].AliasOf != "old1" || items[1].ID != "a" {
		t.Fatalf("batch with alias and canonical: %+v %v", items, err)
	}

	// Re-sync merges "a" into "b": chains collapse and a self alias is ignored.
	later := now.Add(time.Hour)
	if _, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "b", Name: "KEXP", RegionKey: "washington", Band: "fm", Freq: f(90.3), StreamURL: "https://a/1", AbsorbedIDs: []string{"a", "b"}},
	}, later); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old1", "old2", "a"} {
		st, err := s.GetStation(ctx, id)
		if err != nil || st.ID != "b" || st.AliasOf != id {
			t.Fatalf("collapsed alias %s: %+v %v", id, st, err)
		}
	}
	if _, err := s.GetStation(ctx, "b"); err != nil {
		t.Fatalf("self alias: %v", err)
	}

	// Purge removes the canonical row and the aliases that pointed at it.
	if _, err := s.ReplaceCountry(ctx, "US", nil, later.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Purge(ctx, later.Add(31*24*time.Hour), 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetStation(ctx, "old1"); err != ErrNotFound {
		t.Fatalf("alias survived its canonical: %v", err)
	}
}

func TestStationAliasShadowsSoftDeletedRow(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := time.Unix(1_700_000_000, 0)
	// Both ids were published before the merge, as on an upgraded database.
	_, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "old", Name: "KEXP 90.3", RegionKey: "washington", Band: "fm", Freq: f(90.3), StreamURL: "https://a/1"},
		{ID: "canon", Name: "KEXP", RegionKey: "washington", Band: "fm", Freq: f(90.3), StreamURL: "https://a/2"},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := s.ExistingIDs(ctx, "US")
	if err != nil || !ids["old"] || !ids["canon"] {
		t.Fatalf("existing ids: %v %v", ids, err)
	}

	later := now.Add(time.Hour)
	if _, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "canon", Name: "KEXP", RegionKey: "washington", Band: "fm", Freq: f(90.3), StreamURL: "https://a/2", AbsorbedIDs: []string{"old"}},
	}, later); err != nil {
		t.Fatal(err)
	}
	// "old" is now soft deleted, but callers still ask for it.
	st, err := s.GetStation(ctx, "old")
	if err != nil || st.ID != "canon" || st.AliasOf != "old" || !st.Visible() {
		t.Fatalf("alias over soft deleted row: %+v %v", st, err)
	}
	items, err := s.GetStations(ctx, []string{"old", "canon"})
	if err != nil || len(items) != 2 || items[0].ID != "canon" || items[0].AliasOf != "old" || items[1].ID != "canon" || items[1].AliasOf != "" {
		t.Fatalf("batch over soft deleted row: %+v %v", items, err)
	}
	// An absorbed id is retired, so later merges cannot resurrect it as the
	// survivor and flip the canonical id back onto a soft-deleted row.
	ids, err = s.ExistingIDs(ctx, "US")
	if err != nil || ids["old"] || !ids["canon"] {
		t.Fatalf("retired id offered as a survivor: %v %v", ids, err)
	}
}
