package catalog

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

func TestNormalizeTags(t *testing.T) {
	got := NormalizeTags(" Pop ,pop,87.6,87.6 fm,905fm,128kbps,China, Top 40 ,,news")
	want := []string{"pop", "top 40", "news"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NormalizeTags = %q, want %q", got, want)
	}
}

func TestConvertMergesMirrorsAndFilters(t *testing.T) {
	raw := []radiobrowser.Station{
		{StationUUID: "a", Name: "CNR-1 中国之声", URLResolved: "https://lhttp.qtfm.cn/live/15318317/64k.mp3", ClickCount: 100},
		{StationUUID: "b", Name: "CNR-1 中国之声", URLResolved: "http://ngcdn002.cnr.cn/live/zgzs/index.m3u8", HLS: 1, ClickCount: 50},
		{StationUUID: "c", Name: "Same URL other name", URLResolved: "http://LHTTP.qtfm.cn/live/15318317/64k.mp3/", ClickCount: 10},
		{StationUUID: "d", Name: "北京文艺广播", Tags: "87.6,entertainment", URLResolved: "https://lhttp.qtfm.cn/live/333/64k.mp3", ClickCount: 40},
		{StationUUID: "e", Name: "香港电台", State: "Hong Kong", URLResolved: "https://hk.example/live.mp3"},
		{StationUUID: "f", Name: "No URL"},
		{StationUUID: "g", Name: "FLV video", Codec: "FLV", URLResolved: "https://x.example/a.flv"},
	}
	out := Convert("CN", raw, nil, nil)
	if len(out) != 2 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
	cnr := out[0]
	if cnr.ID != "a" || cnr.RegionKey != RegionNational || cnr.HLS || cnr.Clicks != 160 {
		t.Fatalf("cnr = %+v", cnr)
	}
	if !reflect.DeepEqual(cnr.Alternates, []string{"http://ngcdn002.cnr.cn/live/zgzs/index.m3u8"}) {
		t.Fatalf("alternates = %q", cnr.Alternates)
	}
	bj := out[1]
	if bj.Band != "fm" || bj.Freq == nil || *bj.Freq != 87.6 || bj.RegionKey != "beijing" || !reflect.DeepEqual(bj.Tags, []string{"entertainment"}) {
		t.Fatalf("bj = %+v", bj)
	}

	// A mirror promoted by the health checker survives a re-sync, with the right HLS flag.
	out = Convert("CN", raw, map[string]string{"a": "http://ngcdn002.cnr.cn/live/zgzs/index.m3u8"}, nil)
	if out[0].StreamURL != "http://ngcdn002.cnr.cn/live/zgzs/index.m3u8" || !out[0].HLS {
		t.Fatalf("kept url not honoured: %+v", out[0])
	}
}

// kexpRows are the four live KEXP entries: a network stream and three mirrors
// whose names carry the same callsign and frequency.
func kexpRows() []radiobrowser.Station {
	return []radiobrowser.Station{
		{StationUUID: "a", Name: "KEXP", State: "Washington", URLResolved: "https://kexp.example/net", ClickCount: 76},
		{StationUUID: "b", Name: "KEXP 90.3 FM Seattle", URLResolved: "https://kexp.example/1", ClickCount: 35},
		{StationUUID: "c", Name: "KEXP 90.3 Seattle, WA", State: "Washington", URLResolved: "https://kexp.example/2", ClickCount: 21},
		{StationUUID: "d", Name: "KEXP 90.3", URLResolved: "https://kexp.example/3", ClickCount: 8},
	}
}

func TestConvertMergesCallsignAcrossBandAndRegion(t *testing.T) {
	out := Convert("US", kexpRows(), nil, nil)
	if len(out) != 1 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
	st := out[0]
	if st.ID != "a" || st.RegionKey != "washington" || st.Freq == nil || *st.Freq != 90.3 || st.Band != "fm" {
		t.Fatalf("merged = %+v", st)
	}
	if st.Clicks != 140 || len(st.Alternates) != 3 || len(st.AbsorbedIDs) != 3 {
		t.Fatalf("merged = clicks %d alternates %d absorbed %v", st.Clicks, len(st.Alternates), st.AbsorbedIDs)
	}
	if !reflect.DeepEqual(st.AbsorbedIDs, []string{"b", "c", "d"}) {
		t.Fatalf("absorbed = %v", st.AbsorbedIDs)
	}

	// An id already published wins over popularity, so favourites keep working.
	out = Convert("US", kexpRows(), nil, map[string]bool{"c": true})
	if out[0].ID != "c" || len(out[0].AbsorbedIDs) != 3 {
		t.Fatalf("existing id not preferred: %+v", out[0])
	}
}

// TestConvertKeepsSurvivorWhenClicksMove replays two syncs against a real
// store: after the first merge retires three ids, a later sync in which an
// absorbed row is the most popular one must not make it the survivor, or every
// favourite holding the old canonical id would land on a soft-deleted row.
func TestConvertKeepsSurvivorWhenClicksMove(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	now := time.Unix(1_700_000_000, 0)
	first := Convert("US", kexpRows(), nil, nil)
	if _, err := s.ReplaceCountry(ctx, "US", first, now); err != nil {
		t.Fatal(err)
	}
	ids, err := s.ExistingIDs(ctx, "US")
	if err != nil {
		t.Fatal(err)
	}

	raw := kexpRows()
	raw[1].ClickCount = 900 // "b" (absorbed by the first sync) is now the most popular
	second := Convert("US", raw, nil, ids)
	if len(second) != 1 || second[0].ID != first[0].ID {
		t.Fatalf("survivor flipped: first %q, second %+v", first[0].ID, second)
	}
	if _, err := s.ReplaceCountry(ctx, "US", second, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, old := range []string{"b", "c", "d"} {
		st, err := s.GetStation(ctx, old)
		if err != nil || st.ID != first[0].ID || st.AliasOf != old {
			t.Fatalf("alias %s: %+v %v", old, st, err)
		}
	}
}

func TestConvertKeepsKnownFrequenciesApart(t *testing.T) {
	out := Convert("US", []radiobrowser.Station{
		{StationUUID: "a", Name: "KISS 98.1", State: "California", URLResolved: "https://kiss.example/1", ClickCount: 30},
		{StationUUID: "b", Name: "KISS 98.3", State: "Alabama", URLResolved: "https://kiss.example/2", ClickCount: 20},
		// No frequency: ambiguous across several KISS markets, so it stays alone.
		{StationUUID: "c", Name: "Kiss 108", State: "Massachusetts", URLResolved: "https://kiss.example/3", ClickCount: 10},
		{StationUUID: "d", Name: "KISS", URLResolved: "https://kiss.example/4", ClickCount: 5},
	}, nil, nil)
	if len(out) != 4 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
}

func TestConvertResolvesAmbiguityByRegion(t *testing.T) {
	out := Convert("US", []radiobrowser.Station{
		{StationUUID: "a", Name: "WQXR 105.9 FM", State: "New York", URLResolved: "https://wqxr.example/1", ClickCount: 30},
		{StationUUID: "b", Name: "WQXR", State: "New Jersey", URLResolved: "https://wqxr.example/2", ClickCount: 20},
		// The state tells which of the two WQXR markets this stream belongs to.
		{StationUUID: "c", Name: "WQXR", State: "New York", URLResolved: "https://wqxr.example/3", ClickCount: 10},
	}, nil, nil)
	if len(out) != 2 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
	if out[0].RegionKey != "new-york" || out[0].Clicks != 40 || len(out[0].Alternates) != 1 {
		t.Fatalf("new york group = %+v", out[0])
	}
	if out[1].RegionKey != "new-jersey" {
		t.Fatalf("new jersey group = %+v", out[1])
	}
}

func TestConvertMergesAcrossOtherRegion(t *testing.T) {
	out := Convert("CN", []radiobrowser.Station{
		{StationUUID: "a", Name: "邯郸音乐广播", State: "Hebei", URLResolved: "https://cn.example/1", ClickCount: 40},
		{StationUUID: "b", Name: "邯郸音乐广播", URLResolved: "https://cn.example/2", ClickCount: 10},
	}, nil, nil)
	if len(out) != 1 || out[0].RegionKey != "hebei" || out[0].Clicks != 50 {
		t.Fatalf("got %+v", out)
	}
}

func TestConvertKeepsTwoKnownRegionsApart(t *testing.T) {
	out := Convert("US", []radiobrowser.Station{
		{StationUUID: "a", Name: "KISS 98.1", State: "California", URLResolved: "https://kiss.example/1", ClickCount: 30},
		{StationUUID: "b", Name: "KISS 98.1", State: "Texas", URLResolved: "https://kiss.example/2", ClickCount: 20},
	}, nil, nil)
	if len(out) != 2 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
}

func TestConvertCallsignSuffixSignificant(t *testing.T) {
	out := Convert("US", []radiobrowser.Station{
		{StationUUID: "a", Name: "WBAL", State: "Maryland", URLResolved: "https://wbal.example/am", ClickCount: 30},
		{StationUUID: "b", Name: "WBAL-FM 88.1", State: "Maryland", URLResolved: "https://wbal.example/fm", ClickCount: 20},
	}, nil, nil)
	if len(out) != 2 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
}

func TestConvertMergesNameWithAndWithoutFrequency(t *testing.T) {
	out := Convert("US", []radiobrowser.Station{
		{StationUUID: "a", Name: "KSBJ", URLResolved: "https://ksbj.example/net", ClickCount: 30},
		{StationUUID: "b", Name: "KSBJ 89.3 FM", State: "Texas", URLResolved: "https://ksbj.example/fm", ClickCount: 10},
	}, nil, nil)
	if len(out) != 1 {
		t.Fatalf("got %d stations: %+v", len(out), out)
	}
	st := out[0]
	if st.RegionKey != "texas" || st.Freq == nil || *st.Freq != 89.3 || st.Band != "fm" || st.Clicks != 40 {
		t.Fatalf("merged = %+v", st)
	}
}
