package catalog

import (
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

var (
	reFreqTag = regexp.MustCompile(`(?i)^(\d{2,3}([.,]\d{1,2})?\s*(fm|mhz)?|\d{3,4}\s*fm|fm\s*\d{2,3}([.,]\d)?)$`)
	reBitrate = regexp.MustCompile(`(?i)^\d+\s*k(bps)?$`)
	noiseTags = map[string]bool{"china": true, "usa": true, "united states": true, "us": true, "america": true, "radio": true, "fm": true, "中国": true, "电台": true, "广播": true}
	maxTags   = 8
)

// NormalizeTags lowercases, trims and de-duplicates tags, dropping frequency,
// bitrate and country noise that makes poor genre filters.
func NormalizeTags(raw string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range strings.Split(raw, ",") {
		t = strings.ToLower(strings.Join(strings.Fields(t), " "))
		if t == "" || len([]rune(t)) > 24 || seen[t] || noiseTags[t] || reFreqTag.MatchString(t) || reBitrate.MatchString(t) {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) == maxTags {
			break
		}
	}
	return out
}

// streamKey identifies a stream regardless of scheme, case, trailing slash or query noise.
func streamKey(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.ToLower(raw)
	}
	return strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/")
}

// nameKey folds a station name for duplicate detection: case, spaces and punctuation are ignored.
func nameKey(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func cleanName(s string) string {
	return strings.Join(strings.FieldsFunc(s, unicode.IsSpace), " ")
}

func isPlayableURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func isHLSURL(streamURL string) bool {
	u, err := url.Parse(streamURL)
	return err == nil && strings.HasSuffix(strings.ToLower(u.Path), ".m3u8")
}

// Convert turns raw Radio Browser stations of one country into catalog rows:
// filters unplayable entries, normalises regions/tags/frequencies and merges
// duplicates. Mirrors of the same station become alternates of one row.
// keepURL lets the caller pin the currently working URL of an existing row.
func Convert(country string, raw []radiobrowser.Station, keepURL map[string]string) []store.Station {
	type group struct {
		st   store.Station
		urls []string
		hls  map[string]bool
		seen map[string]bool
	}
	var (
		groups  []*group
		byURL   = map[string]*group{}
		byIdent = map[string]*group{}
	)
	// raw is ordered by popularity, so the first station of each group is the best one.
	sort.SliceStable(raw, func(i, j int) bool { return raw[i].ClickCount > raw[j].ClickCount })

	for _, r := range raw {
		streamURL := strings.TrimSpace(r.URLResolved)
		if streamURL == "" {
			streamURL = strings.TrimSpace(r.URL)
		}
		name := cleanName(r.Name)
		codec := strings.ToUpper(strings.TrimSpace(r.Codec))
		if name == "" || !isPlayableURL(streamURL) || strings.Contains(codec, "FLV") {
			continue
		}
		var region store.Station
		switch country {
		case "CN":
			reg, excluded := NormalizeCN(r.State, name)
			if excluded {
				continue
			}
			region.RegionKey, region.RegionName, region.RegionEn = reg.Key, reg.Name, reg.NameEn
		default:
			reg, city := NormalizeUS(r.State)
			region.RegionKey, region.RegionName, region.RegionEn, region.City = reg.Key, reg.Name, reg.NameEn, city
		}
		tags := NormalizeTags(r.Tags)
		rawTags := strings.Split(r.Tags, ",")
		var freq *float64
		band := "net"
		if f, ok := ParseFrequency(name, rawTags); ok {
			freq, band = &f, "fm"
		}

		uk := streamKey(streamURL)
		ident := nameKey(name) + "|" + region.RegionKey + "|" + band
		if freq != nil {
			ident += "|" + strconv.FormatFloat(*freq, 'f', 1, 64)
		}
		g := byURL[uk]
		if g == nil && len(nameKey(name)) >= 2 {
			g = byIdent[ident]
		}
		if g != nil {
			if !g.seen[uk] {
				g.seen[uk] = true
				g.urls = append(g.urls, streamURL)
				g.hls[streamURL] = r.HLS == 1 || isHLSURL(streamURL)
			}
			byURL[uk] = g
			g.st.Clicks += r.ClickCount
			g.st.Votes += r.Votes
			if g.st.Favicon == "" && isPlayableURL(r.Favicon) {
				g.st.Favicon = r.Favicon
			}
			continue
		}
		if codec == "UNKNOWN" {
			codec = ""
		}
		favicon := ""
		if isPlayableURL(r.Favicon) {
			favicon = r.Favicon
		}
		homepage := ""
		if isPlayableURL(r.Homepage) {
			homepage = r.Homepage
		}
		g = &group{
			st: store.Station{
				ID: r.StationUUID, Name: name, Country: country,
				RegionKey: region.RegionKey, RegionName: region.RegionName, RegionEn: region.RegionEn, City: region.City,
				Freq: freq, Band: band, Tags: tags, Language: strings.ToLower(strings.TrimSpace(r.Language)),
				Codec: codec, Bitrate: r.Bitrate, StreamURL: streamURL,
				Homepage: homepage, Favicon: favicon, Clicks: r.ClickCount, Votes: r.Votes,
			},
			urls: []string{streamURL},
			hls:  map[string]bool{streamURL: r.HLS == 1 || isHLSURL(streamURL)},
			seen: map[string]bool{uk: true},
		}
		groups = append(groups, g)
		byURL[uk] = g
		byIdent[ident] = g
	}

	out := make([]store.Station, 0, len(groups))
	for _, g := range groups {
		st := g.st
		if k, ok := keepURL[st.ID]; ok {
			for _, u := range g.urls {
				if u == k {
					st.StreamURL = k
				}
			}
		}
		st.Alternates = []string{}
		for _, u := range g.urls {
			if u != st.StreamURL {
				st.Alternates = append(st.Alternates, u)
			}
		}
		st.HLS = g.hls[st.StreamURL]
		out = append(out, st)
	}
	return out
}
