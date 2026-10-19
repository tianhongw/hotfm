package catalog

import (
	"reflect"
	"testing"

	"hotfm/server/internal/radiobrowser"
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
	out := Convert("CN", raw, nil)
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
	out = Convert("CN", raw, map[string]string{"a": "http://ngcdn002.cnr.cn/live/zgzs/index.m3u8"})
	if out[0].StreamURL != "http://ngcdn002.cnr.cn/live/zgzs/index.m3u8" || !out[0].HLS {
		t.Fatalf("kept url not honoured: %+v", out[0])
	}
}
