package store

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestStationNameMatching(t *testing.T) {
	for _, tc := range []struct {
		query, name, metadata string
		want                  bool
	}{
		{"kex", "KEXP Seattle", "KEXP Seattle indie", true},
		{"K-EXP", "KEXP", "KEXP", true},
		{"k exp", "KEXP", "KEXP", true},
		{"groovesalad", "Groove Salad", "Groove Salad ambient", true},
		{"salad groove", "Groove Salad", "Groove Salad ambient", true},
		{"cafe", "Café Radio", "Café Radio", true},
		{"ＫＥＸＰ", "KEXP", "KEXP", true},
		{"kexq", "KEXP Seattle", "KEXP Seattle", true},
		{"kxep", "KEXP Seattle", "KEXP Seattle", true},
		{"grove salad", "Groove Salad", "Groove Salad ambient", true},
		{"grooove salad", "Groove Salad", "Groove Salad ambient", true},
		{"groovesald", "Groove Salad", "Groove Salad ambient", true},
		{"classicla", "Classical Radio", "Classical Radio", true},
		{"seattle indie", "KEXP", "KEXP Seattle indie", true},
		{"kexq seattle", "KEXP", "KEXP Seattle indie", true},
		{"音乐", "北京音乐广播", "北京音乐广播", true},
		{"北京 广播", "北京音乐广播", "北京音乐广播", true},
		{"50%", "50% Jazz", "50% Jazz", true},
		{"50%", "50 Jazz", "50 Jazz", false},
		{"_", "KEXP", "KEXP", false},
		{"\\", "KEXP", "KEXP", false},
		{"!!!", "KEXP", "KEXP", false},
		{"kxp", "KEXP", "KEXP", false},
		{"999", "997 FM", "997 FM", false},
		{"北景", "北京音乐广播", "北京音乐广播", false},
		{"zzzzzz", "KEXP Seattle", "KEXP Seattle indie", false},
		{"kexq boston", "KEXP Seattle", "KEXP Seattle indie", false},
	} {
		t.Run(tc.query+"/"+tc.name, func(t *testing.T) {
			got := newStationSearch(tc.query).score(tc.name, tc.metadata)
			if (got >= 0) != tc.want {
				t.Fatalf("score=%d, want match=%v", got, tc.want)
			}
		})
	}
}

func TestSearchScopeRankingAndPagination(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	now := time.Now()
	stations := []Station{
		{ID: "exact", Name: "KEXP", RegionKey: "washington", Freq: f(90.3), Band: "fm", Clicks: 1},
		{ID: "partial", Name: "KEXP Seattle", RegionKey: "washington", Freq: f(91.3), Band: "fm", Clicks: 10},
		{ID: "typo", Name: "KEXQ", RegionKey: "california", Freq: f(89.3), Band: "fm", Clicks: 1000},
		{ID: "metadata", Name: "Indie Radio", RegionKey: "california", Tags: []string{"kexp"}, Band: "net", Clicks: 100},
		{ID: "dead", Name: "KEXP Dead", Band: "net"},
		{ID: "deleted", Name: "KEXP Deleted", Band: "net"},
	}
	// A match beyond the first browsing page must still be found.
	for i := 0; i < 60; i++ {
		stations = append(stations, Station{ID: fmt.Sprintf("filler-%02d", i), Name: "Unrelated Station", Band: "net", Clicks: 10000})
	}
	if _, err := s.ReplaceCountry(ctx, "US", stations, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReplaceCountry(ctx, "CN", []Station{{ID: "china", Name: "KEXP", Band: "net"}}, now); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateHealth(ctx, "dead", func(h *Health) { h.State = HealthDead }); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE stations SET deleted_at = ? WHERE id = 'deleted'", now.Unix()); err != nil {
		t.Fatal(err)
	}
	check := func(q Query, wantTotal int, wantIDs ...string) {
		t.Helper()
		items, total, err := s.ListStations(ctx, q)
		var ids []string
		for _, st := range items {
			ids = append(ids, st.ID)
		}
		if err != nil || total != wantTotal || !reflect.DeepEqual(ids, wantIDs) {
			t.Fatalf("query=%+v: total=%d ids=%v err=%v; want %d %v", q, total, ids, err, wantTotal, wantIDs)
		}
	}
	check(Query{Country: "US", Q: "kexp", Limit: 2}, 4, "exact", "partial")
	check(Query{Country: "US", Q: "kexp", Limit: 2, Offset: 2}, 4, "metadata", "typo")
	check(Query{Country: "US", Q: "kexp", Limit: 2, Offset: 10}, 4)
	check(Query{Country: "US", Region: "washington", Q: "kexp", Limit: 10}, 2, "exact", "partial")
	check(Query{Country: "US", Region: "california", Q: "kexp", Limit: 10}, 2, "metadata", "typo")
	check(Query{Country: "CN", Q: "kexp", Limit: 10}, 1, "china")
	check(Query{Q: "kexp", Limit: 10}, 5, "exact", "china", "partial", "metadata", "typo")
	check(Query{Country: "US", Q: "kexp", Band: "net", Limit: 10}, 1, "metadata")
	check(Query{Country: "US", Q: "kexp", Freq: f(90.3), Limit: 10}, 1, "exact")
	check(Query{Country: "US", Q: "kexp", Sort: "freq", Limit: 10}, 4, "typo", "exact", "partial", "metadata")
	check(Query{Country: "US", Q: "kexp", Sort: "name", Limit: 10}, 4, "metadata", "exact", "partial", "typo")
	check(Query{Country: "US", Q: "zzzzzz", Limit: 10}, 0)
}

func TestSearchPrefersCloserSpellingOverPopularity(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	if _, err := s.ReplaceCountry(ctx, "US", []Station{
		{ID: "closest", Name: "Classical Radio", Band: "net", Clicks: 1},
		{ID: "popular", Name: "Classic Hits", Band: "net", Clicks: 1000},
	}, time.Now()); err != nil {
		t.Fatal(err)
	}
	items, total, err := s.ListStations(ctx, Query{Country: "US", Q: "classicla", Limit: 10})
	if err != nil || total != 2 || len(items) != 2 || items[0].ID != "closest" {
		t.Fatalf("closest spelling should lead: total=%d items=%v err=%v", total, items, err)
	}
}
