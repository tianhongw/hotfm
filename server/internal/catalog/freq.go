package catalog

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	fmMin = 87.5
	fmMax = 108.0
)

var (
	// "FM 101.7", "FM101.7", "fm-97.5", "调频101.7", "调频 FM101.7"
	reFMPrefix = regexp.MustCompile(`(?i)(?:\bfm|调频)\s*[-:：]?\s*(\d{2,3}[.,]\d{1,2})`)
	// "101.7 FM", "97.1FM", "103.9 MHz", "88.5兆赫"
	reFMSuffix = regexp.MustCompile(`(?i)(\d{2,3}[.,]\d{1,2})\s*(?:fm\b|mhz\b|兆赫)`)
	// A bare decimal inside the FM range, e.g. "KIIS 102.7".
	reBareDecimal = regexp.MustCompile(`(?:^|[^\d.])(\d{2,3}\.\d)(?:$|[^\d.])`)
	// Compact tag form used by many Chinese stations: "905fm", "1017fm".
	reCompactTag = regexp.MustCompile(`(?i)^(\d{3,4})\s*fm$`)
)

// ParseFrequency extracts an FM broadcast frequency (MHz) from a station's
// name and tags. It returns ok=false for internet-only streams or when the
// text is too ambiguous (bare integers such as "Z100" or "Hot 97" are ignored
// because they do not identify the exact channel).
func ParseFrequency(name string, tags []string) (float64, bool) {
	for _, re := range []*regexp.Regexp{reFMPrefix, reFMSuffix} {
		if f, ok := firstValid(re, name); ok {
			return f, true
		}
	}
	for _, t := range tags {
		for _, re := range []*regexp.Regexp{reFMPrefix, reFMSuffix} {
			if f, ok := firstValid(re, t); ok {
				return f, true
			}
		}
		if m := reCompactTag.FindStringSubmatch(t); m != nil {
			d := m[1]
			if f, ok := validFreq(d[:len(d)-1] + "." + d[len(d)-1:]); ok {
				return f, true
			}
		}
		// A tag that is nothing but a frequency, e.g. "96.1".
		if f, ok := validFreq(strings.TrimSpace(t)); ok && strings.Contains(t, ".") {
			return f, true
		}
	}
	if f, ok := firstValid(reBareDecimal, name); ok {
		return f, true
	}
	return 0, false
}

func firstValid(re *regexp.Regexp, s string) (float64, bool) {
	for _, m := range re.FindAllStringSubmatch(s, -1) {
		if f, ok := validFreq(m[1]); ok {
			return f, true
		}
	}
	return 0, false
}

func validFreq(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.Replace(s, ",", ".", 1), 64)
	if err != nil {
		return 0, false
	}
	f = math.Round(f*10) / 10
	if f < fmMin || f > fmMax {
		return 0, false
	}
	return f, true
}
