package catalog

import "testing"

func TestNormalizeCN(t *testing.T) {
	cases := []struct {
		state, name, want string
		excluded          bool
	}{
		{"Kwangtung", "", "guangdong", false},
		{"Chekiang", "", "zhejiang", false},
		{"Shansi", "", "shanxi", false},
		{"Shensi", "", "shaanxi", false},
		{"Amur River", "", "heilongjiang", false},
		{"Dalian", "", "liaoning", false},
		{"黑龙江", "", "heilongjiang", false},
		{"安丘市", "", "shandong", false},
		{"Shanghai Direct Administered Municipality", "", "shanghai", false},
		{"chongqing", "", "chongqing", false},
		{"", "北京文艺广播", "beijing", false},
		{"", "羊城交通电台", "guangdong", false},
		{"", "CNR-1 中国之声", "national", false},
		{"", "雨声轻音乐", "other", false},
		{"Hong Kong", "", "", true},
		{"Taiwan Hongkong ", "", "", true},
	}
	for _, c := range cases {
		r, ex := NormalizeCN(c.state, c.name)
		if ex != c.excluded || r.Key != c.want {
			t.Errorf("NormalizeCN(%q, %q) = %q, %v; want %q, %v", c.state, c.name, r.Key, ex, c.want, c.excluded)
		}
	}
}

func TestNormalizeUS(t *testing.T) {
	cases := []struct{ state, key, city string }{
		{"California", "california", ""},
		{"San Francisco CA", "california", "San Francisco"},
		{"Chicago, IL  ", "illinois", "Chicago"},
		{"New York City, New York", "new-york", "New York"},
		{"New York NY", "new-york", "New York"},
		{"Washington, DC", "district-of-columbia", "Washington"},
		{"Seattle Washington", "washington", "Seattle"},
		{"West Virginia", "west-virginia", ""},
		{"Arkansas", "arkansas", ""},
		{"Kansas City KS", "kansas", "Kansas City"},
		{"California - San Francisco", "california", "San Francisco"},
		{"Antelope, Ca", "california", "Antelope"},
		{"", "other", ""},
		{"Somewhere", "other", ""},
	}
	for _, c := range cases {
		r, city := NormalizeUS(c.state)
		if r.Key != c.key || city != c.city {
			t.Errorf("NormalizeUS(%q) = %q, %q; want %q, %q", c.state, r.Key, city, c.key, c.city)
		}
	}
}
