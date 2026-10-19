package catalog

import "testing"

func TestParseFrequency(t *testing.T) {
	cases := []struct {
		name string
		tags []string
		want float64
		ok   bool
	}{
		{"102.7 KIIS FM", nil, 102.7, true},
		{"KIIS FM 102.7", nil, 102.7, true},
		{"96.7 KISS FM - KHFI-FM Austin", nil, 96.7, true},
		{"FM101.7 北京音乐广播", nil, 101.7, true},
		{"调频 97.4", nil, 97.4, true},
		{"Hit FM 88,6", nil, 88.6, true},
		{"103.9MHz City Radio", nil, 103.9, true},
		{"WPSB 99.5 / WWOP 100.3 Ocean City", nil, 99.5, true},
		{"SDBA Classics 94.7 Shanghai", nil, 94.7, true},
		{"北京文艺广播", []string{"87.6", "87.6 fm", "entertainment"}, 87.6, true},
		{"CRI环球资迅广播", []string{"905fm", "news"}, 90.5, true},
		{"星岛中文电台", []string{"96.1", "music"}, 96.1, true},
		// No usable frequency.
		{"Z100 - New York's #1 Hit Music Station", nil, 0, false},
		{"181.FM - The Beat", nil, 0, false},
		{".977 80s", nil, 0, false},
		{"101 SMOOTH JAZZ", nil, 0, false},
		{"Radio Paradise Main Mix 320k AAC", nil, 0, false},
		{"WXYZ 1270 AM", nil, 0, false},
		{"Station 120.5 FM", nil, 0, false},
		{"Old 45.5 rpm", nil, 0, false},
	}
	for _, c := range cases {
		got, ok := ParseFrequency(c.name, c.tags)
		if ok != c.ok || got != c.want {
			t.Errorf("ParseFrequency(%q, %v) = %v, %v; want %v, %v", c.name, c.tags, got, ok, c.want, c.ok)
		}
	}
}
