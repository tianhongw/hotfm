package catalog

import (
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
)

var (
	reFreqTag = regexp.MustCompile(`(?i)^(\d{2,3}([.,]\d{1,2})?\s*(fm|mhz)?|\d{3,4}\s*fm|fm\s*\d{2,3}([.,]\d)?)$`)
	reBitrate = regexp.MustCompile(`(?i)^\d+\s*k(bps)?$`)
	// A US broadcast callsign: K/W plus two or three letters, optionally with an
	// -FM/-AM suffix, which keeps WBAL and WBAL-FM apart.
	reCallsign = regexp.MustCompile(`(?i)^[kw][a-z]{2,3}(-fm|-am)?$`)
	// Standalone band/quality markers that say nothing about the station identity.
	bandTokens = map[string]bool{"fm": true, "am": true, "mhz": true, "hd": true, "hd1": true, "hd2": true, "hd3": true}
	noiseTags  = map[string]bool{"china": true, "usa": true, "united states": true, "us": true, "america": true, "radio": true, "fm": true, "中国": true, "电台": true, "广播": true}
	maxTags    = 8
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

// stationGroup is one output station plus the raw rows merged into it.
type stationGroup struct {
	st   store.Station
	ids  []string // member station uuids, best first
	urls []string
	hls  map[string]bool
	seen map[string]bool
}

// hlsFor reports the HLS flag of a stream URL, matching mirrors whose text
// differs only in case or trailing slash.
func (g *stationGroup) hlsFor(u string) bool {
	if h, ok := g.hls[u]; ok {
		return h
	}
	k := streamKey(u)
	for _, raw := range g.urls {
		if streamKey(raw) == k {
			return g.hls[raw]
		}
	}
	return false
}

// callsignKey extracts the US callsign a station name starts with:
// "KEXP 90.3 FM" -> "KEXP", "WBAL-FM" -> "WBAL-FM". Names that do not start
// with a callsign return "", so brands ("Kissin' 99.3") never key together.
func callsignKey(name string) string {
	fields := strings.Fields(cleanName(name))
	if len(fields) == 0 {
		return ""
	}
	tok := strings.TrimRight(fields[0], `.,:;!?"'()[]`)
	if !reCallsign.MatchString(tok) {
		return ""
	}
	return strings.ToUpper(tok)
}

// baseKey folds a station name for duplicate detection: frequency mentions and
// band markers are dropped and, for US stations, a trailing state or the city
// the record already knows about. Empty and single-rune keys are unusable.
func baseKey(country, name, city string) string {
	s := dropSubmatches(name, reFMPrefix, reFMSuffix, reBareDecimal, reCompactTag)
	words := strings.Fields(s)
	kept := words[:0]
	for _, w := range words {
		if bandTokens[strings.ToLower(strings.Trim(w, `.,:;!?"'()[]-&`))] {
			continue
		}
		kept = append(kept, w)
	}
	s = strings.Join(kept, " ")
	if country == "US" {
		s = stripTrailingPlace(s, city)
	}
	k := nameKey(s)
	if len([]rune(k)) < 2 {
		return ""
	}
	return k
}

// dropSubmatches removes the first capture group (the frequency digits) of
// every match of each regexp and leaves the surrounding text in place.
func dropSubmatches(s string, res ...*regexp.Regexp) string {
	for _, re := range res {
		matches := re.FindAllStringSubmatchIndex(s, -1)
		if len(matches) == 0 {
			continue
		}
		var b strings.Builder
		last := 0
		for _, m := range matches {
			if len(m) < 4 || m[2] < 0 {
				continue
			}
			b.WriteString(s[last:m[2]])
			b.WriteString(" ")
			last = m[3]
		}
		b.WriteString(s[last:])
		s = b.String()
	}
	return s
}

// stripTrailingPlace removes a trailing ", <state>" / " <state>" / " <city>"
// that only repeats what the region fields already say.
func stripTrailingPlace(s, city string) string {
	t := strings.TrimSpace(s)
	i := strings.LastIndexAny(t, ", ")
	if i < 0 {
		return t
	}
	tail := strings.TrimSpace(strings.Trim(t[i+1:], ",."))
	if tail == "" || !(isUSPlace(tail) || (city != "" && strings.EqualFold(tail, city))) {
		return t
	}
	head := strings.TrimSpace(strings.TrimRight(t[:i], ",."))
	if head == "" {
		return t
	}
	return head
}

// isUSPlace reports whether w is a state abbreviation or a full state name.
func isUSPlace(w string) bool {
	if len(w) == 2 {
		if _, ok := usByAbbr[strings.ToUpper(w)]; ok {
			return true
		}
	}
	for _, st := range usStates {
		if strings.EqualFold(w, st.name) {
			return true
		}
	}
	return false
}

// compatible reports whether a raw record may join a group: regions must agree
// (an "other" region matches anything) and two known frequencies must be equal.
func compatible(g *stationGroup, regionKey string, freq *float64) bool {
	if g.st.RegionKey != regionKey && g.st.RegionKey != RegionOther && regionKey != RegionOther {
		return false
	}
	return g.st.Freq == nil || freq == nil || *g.st.Freq == *freq
}

// pickCompatible returns the group a record may join, nil if none fits. A
// record without a frequency that fits several groups is ambiguous (KISS is a
// brand in six markets) and stays on its own rather than joining a guess.
func pickCompatible(cands []*stationGroup, regionKey string, freq *float64) *stationGroup {
	var hit *stationGroup
	for _, c := range cands {
		if !compatible(c, regionKey, freq) {
			continue
		}
		if hit != nil && freq == nil {
			return nil
		}
		hit = c
	}
	return hit
}

// primaryID keeps ids stable across syncs: the surviving row is the first
// member the database already published, else the most popular member.
func primaryID(ids []string, existingIDs map[string]bool) string {
	for _, id := range ids {
		if existingIDs[id] {
			return id
		}
	}
	return ids[0]
}

func appendID(ids []string, id string) []string {
	for _, x := range ids {
		if x == id {
			return ids
		}
	}
	return append(ids, id)
}

// Convert turns raw Radio Browser stations of one country into catalog rows:
// filters unplayable entries, normalises regions/tags/frequencies and merges
// duplicates. Mirrors of the same station become alternates of one row.
// keepURL lets the caller pin the currently working URL of an existing row;
// existingIDs holds the ids already published so merged rows keep their id.
func Convert(country string, raw []radiobrowser.Station, keepURL map[string]string, existingIDs map[string]bool) []store.Station {
	var (
		groups     []*stationGroup
		byURL      = map[string]*stationGroup{}
		byCallsign = map[string][]*stationGroup{}
		byBase     = map[string][]*stationGroup{}
	)
	us := country == "US"
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
			reg, city := NormalizeUS(r.State, name)
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
		ck := ""
		if us {
			ck = callsignKey(name)
		}
		bk := baseKey(country, name, region.City)

		// The same stream always merges; otherwise the callsign identifies a
		// station best, then the name with frequencies and places stripped.
		g := byURL[uk]
		if g == nil && ck != "" {
			g = pickCompatible(byCallsign[ck], region.RegionKey, freq)
		}
		if g == nil && bk != "" {
			g = pickCompatible(byBase[bk], region.RegionKey, freq)
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
			// The group keeps the best member's identity but learns what the
			// others know about frequency and place.
			if g.st.Freq == nil && freq != nil {
				g.st.Freq, g.st.Band = freq, "fm"
			}
			if g.st.RegionKey == RegionOther && region.RegionKey != RegionOther {
				g.st.RegionKey, g.st.RegionName, g.st.RegionEn = region.RegionKey, region.RegionName, region.RegionEn
			}
			if g.st.City == "" && region.City != "" && region.RegionKey == g.st.RegionKey {
				g.st.City = region.City
			}
			g.ids = appendID(g.ids, r.StationUUID)
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
		g = &stationGroup{
			st: store.Station{
				ID: r.StationUUID, Name: name, Country: country,
				RegionKey: region.RegionKey, RegionName: region.RegionName, RegionEn: region.RegionEn, City: region.City,
				Freq: freq, Band: band, Tags: tags, Language: strings.ToLower(strings.TrimSpace(r.Language)),
				Codec: codec, Bitrate: r.Bitrate, StreamURL: streamURL,
				Homepage: homepage, Favicon: favicon, Clicks: r.ClickCount, Votes: r.Votes,
			},
			ids:  []string{r.StationUUID},
			urls: []string{streamURL},
			hls:  map[string]bool{streamURL: r.HLS == 1 || isHLSURL(streamURL)},
			seen: map[string]bool{uk: true},
		}
		groups = append(groups, g)
		byURL[uk] = g
		if ck != "" {
			byCallsign[ck] = append(byCallsign[ck], g)
		}
		if bk != "" {
			byBase[bk] = append(byBase[bk], g)
		}
	}

	out := make([]store.Station, 0, len(groups))
	for _, g := range groups {
		st := g.st
		st.ID = primaryID(g.ids, existingIDs)
		st.AbsorbedIDs = []string{}
		for _, id := range g.ids {
			if id != st.ID {
				st.AbsorbedIDs = append(st.AbsorbedIDs, id)
			}
		}
		// A mirror the health checker promoted wins over the best member's URL.
		for _, id := range append([]string{st.ID}, st.AbsorbedIDs...) {
			k, ok := keepURL[id]
			if !ok || !g.seen[streamKey(k)] {
				continue
			}
			st.StreamURL = k
			break
		}
		st.Alternates = []string{}
		for _, u := range g.urls {
			if u != st.StreamURL {
				st.Alternates = append(st.Alternates, u)
			}
		}
		st.HLS = g.hlsFor(st.StreamURL)
		out = append(out, st)
	}
	return out
}
