package api

import (
	"net/url"
	"strings"

	"hotfm/server/internal/store"
)

type regionDTO struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	NameEn string `json:"nameEn"`
}

type streamDTO struct {
	Type    string `json:"type"` // audio | hls
	URL     string `json:"url"`
	Proxied bool   `json:"proxied"`
}

type stationDTO struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Country  string    `json:"country"`
	Region   regionDTO `json:"region"`
	City     string    `json:"city"`
	Freq     *float64  `json:"freq"`
	Band     string    `json:"band"`
	Tags     []string  `json:"tags"`
	Codec    string    `json:"codec"`
	Bitrate  int       `json:"bitrate"`
	Homepage string    `json:"homepage"`
	Logo     *string   `json:"logo"`
	Stream   streamDTO `json:"stream"`
	Health   string    `json:"health"`
	Offline  bool      `json:"offline"`
	Votes    int       `json:"votes"`
}

func (s *Server) stationDTO(st *store.Station) stationDTO {
	d := stationDTO{
		ID: st.ID, Name: st.Name, Country: st.Country,
		Region: regionDTO{st.RegionKey, st.RegionName, st.RegionEn},
		City:   st.City, Freq: st.Freq, Band: st.Band, Tags: st.Tags, Codec: st.Codec,
		Bitrate: st.Bitrate, Homepage: st.Homepage, Health: st.Health, Offline: !st.Visible(), Votes: st.Votes,
		Stream: s.streamFor(st),
	}
	if st.Favicon != "" {
		l := "/api/v1/logo/" + url.PathEscape(st.ID)
		d.Logo = &l
	}
	return d
}

// streamFor decides how the client should play a station. HLS always goes
// through the proxy (CORS); plain audio may play directly from https origins
// in "auto" mode to save bandwidth.
func (s *Server) streamFor(st *store.Station) streamDTO {
	id := url.PathEscape(st.ID)
	if st.HLS {
		return streamDTO{Type: "hls", URL: "/api/v1/hls/" + id, Proxied: true}
	}
	if s.cfg.StreamMode == "auto" && strings.HasPrefix(st.StreamURL, "https://") {
		return streamDTO{Type: "audio", URL: st.StreamURL, Proxied: false}
	}
	return streamDTO{Type: "audio", URL: "/api/v1/stream/" + id, Proxied: true}
}

type dialStationDTO struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	City   string `json:"city"`
	Health string `json:"health"`
}

type dialSlotDTO struct {
	Freq     float64          `json:"freq"`
	Total    int              `json:"total"`
	Stations []dialStationDTO `json:"stations"`
}
