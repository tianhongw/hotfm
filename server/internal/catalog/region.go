package catalog

import (
	"regexp"
	"sort"
	"strings"
)

// Region is a normalised first-level administrative division.
type Region struct {
	Key    string // stable ascii key, e.g. "guangdong", "california"
	Name   string // native display name, e.g. "广东", "California"
	NameEn string
}

const (
	RegionOther    = "other"
	RegionNational = "national"
)

var (
	cnOther    = Region{RegionOther, "其他", "Other"}
	cnNational = Region{RegionNational, "全国", "National"}
	usOther    = Region{RegionOther, "Other", "Other"}
)

type cnProvince struct {
	Region
	aliases []string // lowercase latin aliases incl. postal romanisation and major cities
	zhNames []string // Chinese names / major cities used for name-based detection
}

var cnProvinces = []cnProvince{
	{Region{"beijing", "北京", "Beijing"}, []string{"beijing", "peking", "peiping"}, []string{"北京"}},
	{Region{"tianjin", "天津", "Tianjin"}, []string{"tianjin", "tientsin"}, []string{"天津"}},
	{Region{"hebei", "河北", "Hebei"}, []string{"hebei", "hopei", "hopeh", "shijiazhuang", "tangshan", "baoding"}, []string{"河北", "石家庄", "唐山", "保定"}},
	{Region{"shanxi", "山西", "Shanxi"}, []string{"shanxi", "shansi", "taiyuan", "datong"}, []string{"山西", "太原", "大同"}},
	{Region{"neimenggu", "内蒙古", "Inner Mongolia"}, []string{"inner mongolia", "neimenggu", "nei mongol", "hohhot", "baotou"}, []string{"内蒙古", "呼和浩特", "包头"}},
	{Region{"liaoning", "辽宁", "Liaoning"}, []string{"liaoning", "shenyang", "dalian", "anshan"}, []string{"辽宁", "沈阳", "大连", "鞍山"}},
	{Region{"jilin", "吉林", "Jilin"}, []string{"jilin", "kirin", "changchun"}, []string{"吉林", "长春"}},
	{Region{"heilongjiang", "黑龙江", "Heilongjiang"}, []string{"heilongjiang", "heilungkiang", "amur river", "harbin", "daqing"}, []string{"黑龙江", "哈尔滨", "大庆"}},
	{Region{"shanghai", "上海", "Shanghai"}, []string{"shanghai"}, []string{"上海"}},
	{Region{"jiangsu", "江苏", "Jiangsu"}, []string{"jiangsu", "kiangsu", "nanjing", "nanking", "suzhou", "wuxi", "changzhou", "nantong", "xuzhou", "yangzhou"}, []string{"江苏", "南京", "苏州", "无锡", "常州", "南通", "徐州", "扬州"}},
	{Region{"zhejiang", "浙江", "Zhejiang"}, []string{"zhejiang", "chekiang", "hangzhou", "ningbo", "wenzhou", "shaoxing", "jinhua", "taizhou"}, []string{"浙江", "杭州", "宁波", "温州", "绍兴", "金华", "台州"}},
	{Region{"anhui", "安徽", "Anhui"}, []string{"anhui", "anhwei", "hefei", "wuhu"}, []string{"安徽", "合肥", "芜湖"}},
	{Region{"fujian", "福建", "Fujian"}, []string{"fujian", "fukien", "fuzhou", "xiamen", "amoy", "quanzhou"}, []string{"福建", "福州", "厦门", "泉州"}},
	{Region{"jiangxi", "江西", "Jiangxi"}, []string{"jiangxi", "kiangsi", "nanchang"}, []string{"江西", "南昌"}},
	{Region{"shandong", "山东", "Shandong"}, []string{"shandong", "shantung", "jinan", "qingdao", "tsingtao", "yantai", "weifang", "anqiu"}, []string{"山东", "济南", "青岛", "烟台", "潍坊", "安丘"}},
	{Region{"henan", "河南", "Henan"}, []string{"henan", "honan", "zhengzhou", "luoyang"}, []string{"河南", "郑州", "洛阳"}},
	{Region{"hubei", "湖北", "Hubei"}, []string{"hubei", "hupei", "hupeh", "wuhan"}, []string{"湖北", "武汉"}},
	{Region{"hunan", "湖南", "Hunan"}, []string{"hunan", "changsha"}, []string{"湖南", "长沙"}},
	{Region{"guangdong", "广东", "Guangdong"}, []string{"guangdong", "kwangtung", "canton", "guangzhou", "shenzhen", "foshan", "dongguan", "zhuhai", "shantou"}, []string{"广东", "广州", "深圳", "佛山", "东莞", "珠海", "汕头", "羊城"}},
	{Region{"guangxi", "广西", "Guangxi"}, []string{"guangxi", "kwangsi", "nanning", "guilin"}, []string{"广西", "南宁", "桂林"}},
	{Region{"hainan", "海南", "Hainan"}, []string{"hainan", "haikou", "sanya"}, []string{"海南", "海口", "三亚"}},
	{Region{"chongqing", "重庆", "Chongqing"}, []string{"chongqing", "chungking"}, []string{"重庆"}},
	{Region{"sichuan", "四川", "Sichuan"}, []string{"sichuan", "szechuan", "szechwan", "chengdu"}, []string{"四川", "成都"}},
	{Region{"guizhou", "贵州", "Guizhou"}, []string{"guizhou", "kweichow", "guiyang"}, []string{"贵州", "贵阳"}},
	{Region{"yunnan", "云南", "Yunnan"}, []string{"yunnan", "kunming"}, []string{"云南", "昆明"}},
	{Region{"xizang", "西藏", "Tibet"}, []string{"xizang", "tibet", "lhasa"}, []string{"西藏", "拉萨"}},
	{Region{"shaanxi", "陕西", "Shaanxi"}, []string{"shaanxi", "shensi", "xian", "xi'an"}, []string{"陕西", "西安"}},
	{Region{"gansu", "甘肃", "Gansu"}, []string{"gansu", "kansu", "lanzhou"}, []string{"甘肃", "兰州"}},
	{Region{"qinghai", "青海", "Qinghai"}, []string{"qinghai", "tsinghai", "xining"}, []string{"青海", "西宁"}},
	{Region{"ningxia", "宁夏", "Ningxia"}, []string{"ningxia", "ningsia", "yinchuan"}, []string{"宁夏", "银川"}},
	{Region{"xinjiang", "新疆", "Xinjiang"}, []string{"xinjiang", "sinkiang", "urumqi"}, []string{"新疆", "乌鲁木齐"}},
}

// Places that are not part of mainland China; the user scope is mainland only.
var cnExcluded = []string{"hong kong", "hongkong", "香港", "taiwan", "台湾", "臺灣", "macau", "macao", "澳门", "澳門"}

// Station-name markers of nationwide broadcasters.
var cnNationalMarkers = []string{"cnr", "中国之声", "中央人民广播", "中国国际广播", "cri", "cgtn", "cctv", "环球资讯", "中国交通广播", "中国乡村之声", "经济之声", "音乐之声"}

var reNonLetters = regexp.MustCompile(`[^a-z' ]+`)

// NormalizeCN maps a Radio Browser "state" value (which mixes pinyin, postal
// romanisation, city names and Chinese) to a mainland province. The station
// name is used as a fallback. excluded reports HK/MO/TW entries.
func NormalizeCN(state, name string) (r Region, excluded bool) {
	s := strings.ToLower(strings.TrimSpace(state))
	for _, e := range cnExcluded {
		if s != "" && strings.Contains(s, e) {
			return Region{}, true
		}
	}
	if s != "" {
		latin := " " + strings.Join(strings.Fields(reNonLetters.ReplaceAllString(s, " ")), " ") + " "
		for _, p := range cnProvinces {
			for _, zh := range p.zhNames {
				if strings.Contains(s, zh) {
					return p.Region, false
				}
			}
			for _, a := range p.aliases {
				if strings.Contains(latin, " "+a+" ") {
					return p.Region, false
				}
			}
		}
	}
	lname := strings.ToLower(name)
	for _, m := range cnNationalMarkers {
		if strings.Contains(lname, m) {
			return cnNational, false
		}
	}
	for _, p := range cnProvinces {
		for _, zh := range p.zhNames {
			if strings.Contains(name, zh) {
				return p.Region, false
			}
		}
	}
	return cnOther, false
}

type usState struct {
	abbr, name string
}

var usStates = []usState{
	{"AL", "Alabama"}, {"AK", "Alaska"}, {"AZ", "Arizona"}, {"AR", "Arkansas"}, {"CA", "California"},
	{"CO", "Colorado"}, {"CT", "Connecticut"}, {"DE", "Delaware"}, {"FL", "Florida"}, {"GA", "Georgia"},
	{"HI", "Hawaii"}, {"ID", "Idaho"}, {"IL", "Illinois"}, {"IN", "Indiana"}, {"IA", "Iowa"},
	{"KS", "Kansas"}, {"KY", "Kentucky"}, {"LA", "Louisiana"}, {"ME", "Maine"}, {"MD", "Maryland"},
	{"MA", "Massachusetts"}, {"MI", "Michigan"}, {"MN", "Minnesota"}, {"MS", "Mississippi"}, {"MO", "Missouri"},
	{"MT", "Montana"}, {"NE", "Nebraska"}, {"NV", "Nevada"}, {"NH", "New Hampshire"}, {"NJ", "New Jersey"},
	{"NM", "New Mexico"}, {"NY", "New York"}, {"NC", "North Carolina"}, {"ND", "North Dakota"}, {"OH", "Ohio"},
	{"OK", "Oklahoma"}, {"OR", "Oregon"}, {"PA", "Pennsylvania"}, {"RI", "Rhode Island"}, {"SC", "South Carolina"},
	{"SD", "South Dakota"}, {"TN", "Tennessee"}, {"TX", "Texas"}, {"UT", "Utah"}, {"VT", "Vermont"},
	{"VA", "Virginia"}, {"WA", "Washington"}, {"WV", "West Virginia"}, {"WI", "Wisconsin"}, {"WY", "Wyoming"},
	{"DC", "District of Columbia"}, {"PR", "Puerto Rico"},
}

// usByLength lists states longest name first so "West Virginia" wins over
// "Virginia" and "Arkansas" is never read as "Kansas".
var usByLength = func() []usState {
	s := append([]usState(nil), usStates...)
	sort.Slice(s, func(i, j int) bool { return len(s[i].name) > len(s[j].name) })
	return s
}()

var reDC = regexp.MustCompile(`(?i)\b(washington,?\s*d\.?c\.?|d\.c\.)`)

// NormalizeUS parses values like "California", "San Francisco CA",
// "Chicago, IL", "New York City, New York" or "California - San Francisco"
// into a state and, when present, a city.
func NormalizeUS(state string) (r Region, city string) {
	s := strings.Join(strings.Fields(state), " ")
	if s == "" {
		return usOther, ""
	}
	if loc := reDC.FindStringIndex(s); loc != nil {
		return usRegion(usState{"DC", "District of Columbia"}), "Washington"
	}
	// Trailing postal abbreviation: "Austin TX", "Chicago, IL", "New York NY".
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == ',' || r == '-' })
	if n := len(fields); n > 0 && len(fields[n-1]) == 2 {
		last := strings.ToUpper(fields[n-1])
		for _, st := range usStates {
			if st.abbr == last {
				return usRegion(st), titleCase(strings.ToLower(strings.Join(fields[:n-1], " ")))
			}
		}
	}
	ls := " " + strings.ToLower(reNonLetters.ReplaceAllString(strings.ToLower(s), " ")) + " "
	ls = " " + strings.Join(strings.Fields(ls), " ") + " "
	for _, st := range usByLength {
		n := " " + strings.ToLower(st.name) + " "
		if i := strings.Index(ls, n); i >= 0 {
			rest := strings.TrimSpace(ls[:i] + " " + ls[i+len(n):])
			// "New York City, New York" leaves "city", which is not a place.
			if rest == "city" {
				rest = ""
			}
			if st.name == "New York" && strings.Contains(ls, " new york city ") {
				rest = "new york"
			}
			return usRegion(st), titleCase(rest)
		}
	}
	return usOther, ""
}

func usRegion(st usState) Region {
	return Region{Key: strings.ReplaceAll(strings.ToLower(st.name), " ", "-"), Name: st.name, NameEn: st.name}
}

func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
