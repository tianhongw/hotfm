// Package api exposes the versioned HTTP API (/api/v1) used by the web app
// and, later, other clients. The contract is documented in api/openapi.yaml.
package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"hotfm/server/internal/catalog"
	"hotfm/server/internal/config"
	"hotfm/server/internal/health"
	"hotfm/server/internal/logo"
	"hotfm/server/internal/radiobrowser"
	"hotfm/server/internal/store"
	"hotfm/server/internal/stream"
)

type Server struct {
	cfg     *config.Config
	store   *store.Store
	proxy   *stream.Proxy
	hub     *stream.Hub
	logos   *logo.Cache
	checker *health.Checker
	rb      *radiobrowser.Client
	log     *slog.Logger
	limiter *ipLimiter

	// once-per-window dedupe for click forwarding and failure reports
	dedupeMu sync.Mutex
	dedupe   map[string]time.Time
}

type Deps struct {
	Config  *config.Config
	Store   *store.Store
	Proxy   *stream.Proxy
	Hub     *stream.Hub
	Logos   *logo.Cache
	Checker *health.Checker
	Radio   *radiobrowser.Client
	Log     *slog.Logger
}

func New(d Deps) *Server {
	return &Server{
		cfg: d.Config, store: d.Store, proxy: d.Proxy, hub: d.Hub, logos: d.Logos,
		checker: d.Checker, rb: d.Radio, log: d.Log,
		limiter: newIPLimiter(20, 60),
		dedupe:  map[string]time.Time{},
	}
}

// Handler mounts the API; web is served for every other path (SPA).
func (s *Server) Handler(web http.Handler) http.Handler {
	mux := http.NewServeMux()
	j := func(h http.HandlerFunc) http.HandlerFunc { return s.rateLimited(gzipped(h)) }

	mux.HandleFunc("GET /api/v1/countries", j(s.handleCountries))
	mux.HandleFunc("GET /api/v1/regions", j(s.handleRegions))
	mux.HandleFunc("GET /api/v1/tags", j(s.handleTags))
	mux.HandleFunc("GET /api/v1/stations", j(s.handleStations))
	mux.HandleFunc("POST /api/v1/stations/batch", j(s.handleBatch))
	mux.HandleFunc("GET /api/v1/stations/{id}", j(s.handleStation))
	mux.HandleFunc("POST /api/v1/stations/{id}/click", s.rateLimited(s.handleClick))
	mux.HandleFunc("POST /api/v1/stations/{id}/report", s.rateLimited(s.handleReport))
	mux.HandleFunc("GET /api/v1/dial", j(s.handleDial))
	mux.HandleFunc("GET /api/v1/stream/{id}", s.rateLimited(s.handleStream))
	mux.HandleFunc("GET /api/v1/stream/{id}/meta", s.rateLimited(s.handleMeta))
	mux.HandleFunc("GET /api/v1/hls/{id}", s.rateLimited(s.handleHLS))
	mux.HandleFunc("GET /api/v1/hls/{id}/r", s.handleHLSResource) // segments; token-gated
	mux.HandleFunc("GET /api/v1/logo/{id}", s.handleLogo)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "unknown endpoint")
	})
	if web != nil {
		mux.Handle("/", web)
	}
	return s.withBase(mux)
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	var b errorBody
	b.Error.Code, b.Error.Message = code, msg
	writeJSON(w, status, b)
}

func (s *Server) internal(w http.ResponseWriter, err error) {
	s.log.Error("request failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func parseCountry(r *http.Request) (string, bool) {
	c := strings.ToUpper(r.URL.Query().Get("country"))
	for _, k := range catalog.Countries {
		if c == k {
			return c, true
		}
	}
	return "", false
}

func (s *Server) station(w http.ResponseWriter, r *http.Request) (*store.Station, bool) {
	st, err := s.store.GetStation(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "station_not_found", "station not found")
		return nil, false
	}
	if err != nil {
		s.internal(w, err)
		return nil, false
	}
	return st, true
}

// once returns true the first time key is seen within window.
func (s *Server) once(key string, window time.Duration) bool {
	s.dedupeMu.Lock()
	defer s.dedupeMu.Unlock()
	if t, ok := s.dedupe[key]; ok && time.Since(t) < window {
		return false
	}
	if len(s.dedupe) > 100000 {
		s.dedupe = map[string]time.Time{}
	}
	s.dedupe[key] = time.Now()
	return true
}

// --- catalog endpoints ---

func (s *Server) handleCountries(w http.ResponseWriter, r *http.Request) {
	counts, err := s.store.Countries(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	byCode := map[string]int{}
	for _, c := range counts {
		byCode[c.Code] = c.Count
	}
	type countryDTO struct {
		Code     string     `json:"code"`
		Count    int        `json:"count"`
		SyncedAt *time.Time `json:"syncedAt"`
	}
	out := []countryDTO{}
	for _, c := range catalog.Countries {
		d := countryDTO{Code: c, Count: byCode[c]}
		if t, err := s.store.LastSuccessfulSync(r.Context(), c); err == nil && !t.IsZero() {
			d.SyncedAt = &t
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleRegions(w http.ResponseWriter, r *http.Request) {
	country, ok := parseCountry(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_country", "country must be US or CN")
		return
	}
	regions, err := s.store.Regions(r.Context(), country)
	if err != nil {
		s.internal(w, err)
		return
	}
	type regionCountDTO struct {
		regionDTO
		Count   int `json:"count"`
		FMCount int `json:"fmCount"`
	}
	out := make([]regionCountDTO, 0, len(regions))
	for _, g := range regions {
		out = append(out, regionCountDTO{regionDTO{g.Key, g.Name, g.NameEn}, g.Count, g.FMCount})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	country, ok := parseCountry(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_country", "country must be US or CN")
		return
	}
	tags, err := s.store.Tags(r.Context(), country, r.URL.Query().Get("region"), 40)
	if err != nil {
		s.internal(w, err)
		return
	}
	type tagDTO struct {
		Tag   string `json:"tag"`
		Count int    `json:"count"`
	}
	out := make([]tagDTO, 0, len(tags))
	for _, t := range tags {
		out = append(out, tagDTO{t.Tag, t.Count})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("o:" + strconv.Itoa(offset)))
}

func decodeCursor(c string) int {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil || !strings.HasPrefix(string(b), "o:") {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimPrefix(string(b), "o:"))
	return max(n, 0)
}

func (s *Server) handleStations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	country := ""
	if q.Get("country") != "" {
		var ok bool
		if country, ok = parseCountry(r); !ok {
			writeError(w, http.StatusBadRequest, "bad_country", "country must be US or CN")
			return
		}
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	band := q.Get("band")
	if band != "" && band != "fm" && band != "net" {
		writeError(w, http.StatusBadRequest, "bad_band", "band must be fm or net")
		return
	}
	var freq *float64
	if v := q.Get("freq"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 87.5 || f > 108 {
			writeError(w, http.StatusBadRequest, "bad_freq", "freq must be between 87.5 and 108")
			return
		}
		freq = &f
	}
	query := store.Query{
		Country: country, Region: q.Get("region"), Tag: q.Get("tag"), Band: band, Freq: freq,
		Q: strings.TrimSpace(q.Get("q")), Sort: q.Get("sort"), Offset: decodeCursor(q.Get("cursor")), Limit: limit,
	}
	if len([]rune(query.Q)) > 64 {
		writeError(w, http.StatusBadRequest, "bad_query", "query too long")
		return
	}
	items, total, err := s.store.ListStations(r.Context(), query)
	if err != nil {
		s.internal(w, err)
		return
	}
	out := make([]stationDTO, 0, len(items))
	for _, st := range items {
		out = append(out, s.stationDTO(st))
	}
	var next *string
	if query.Offset+len(items) < total {
		c := encodeCursor(query.Offset + len(items))
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": total, "nextCursor": next})
}

func (s *Server) handleStation(w http.ResponseWriter, r *http.Request) {
	if st, ok := s.station(w, r); ok {
		writeJSON(w, http.StatusOK, s.stationDTO(st))
	}
}

func (s *Server) handleBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_body", "expected {\"ids\": [...]}")
		return
	}
	if len(body.IDs) > 200 {
		writeError(w, http.StatusBadRequest, "too_many_ids", "at most 200 ids")
		return
	}
	items, err := s.store.GetStations(r.Context(), body.IDs)
	if err != nil {
		s.internal(w, err)
		return
	}
	out := make([]stationDTO, 0, len(items))
	for _, st := range items {
		out = append(out, s.stationDTO(st))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

const dialSlotSize = 8

func (s *Server) handleDial(w http.ResponseWriter, r *http.Request) {
	country, ok := parseCountry(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_country", "country must be US or CN")
		return
	}
	region := r.URL.Query().Get("region")
	items, err := s.store.DialStations(r.Context(), country, region)
	if err != nil {
		s.internal(w, err)
		return
	}
	slots := []dialSlotDTO{}
	for _, st := range items {
		f := *st.Freq
		if len(slots) == 0 || slots[len(slots)-1].Freq != f {
			slots = append(slots, dialSlotDTO{Freq: f})
		}
		sl := &slots[len(slots)-1]
		sl.Total++
		if len(sl.Stations) < dialSlotSize {
			sl.Stations = append(sl.Stations, dialStationDTO{st.ID, st.Name, st.City, st.Health})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"country": country, "region": region, "slots": slots})
}

// --- playback endpoints ---

var reSID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func (s *Server) sid(r *http.Request) string {
	if sid := r.URL.Query().Get("sid"); reSID.MatchString(sid) {
		return sid
	}
	return ""
}

func (s *Server) writeStreamErr(w http.ResponseWriter, err error) {
	var se *stream.Error
	if errors.As(err, &se) {
		writeError(w, se.Status, se.Code, se.Err.Error())
		return
	}
	s.internal(w, err)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	if st.HLS {
		writeError(w, http.StatusConflict, "is_hls", "station is HLS; use the hls endpoint")
		return
	}
	err := s.proxy.ServeAudio(w, r, st, s.sid(r))
	if err == nil {
		return
	}
	var se *stream.Error
	if errors.As(err, &se) && se.Code == "is_hls" {
		// The catalog had the type wrong; remember it so clients switch to HLS next time.
		_ = s.store.SetHLS(context.WithoutCancel(r.Context()), st.ID, true)
		writeError(w, http.StatusConflict, "is_hls", "station is HLS; use the hls endpoint")
		return
	}
	s.writeStreamErr(w, err)
}

// handleMeta streams "now playing" titles as Server-Sent Events.
func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	sid := s.sid(r)
	if sid == "" {
		writeError(w, http.StatusBadRequest, "bad_sid", "sid must be 8-64 url-safe characters")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	ch, current, cancel := s.hub.Subscribe(sid)
	defer cancel()
	send := func(title string) bool {
		b, _ := json.Marshal(map[string]string{"title": title})
		if _, err := fmt.Fprintf(w, "event: title\ndata: %s\n\n", b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	if _, err := fmt.Fprint(w, "retry: 5000\n\n"); err != nil {
		return
	}
	if current != "" && !send(current) {
		return
	}
	_ = rc.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case t := <-ch:
			if !send(t) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

func (s *Server) handleHLS(w http.ResponseWriter, r *http.Request) {
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	if err := s.proxy.ServeHLS(w, r, st, ""); err != nil {
		s.writeStreamErr(w, err)
	}
}

func (s *Server) handleHLSResource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	target, err := s.proxy.VerifyTarget(id, r.URL.Query())
	if err != nil {
		s.writeStreamErr(w, err)
		return
	}
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	if err := s.proxy.ServeHLS(w, r, st, target); err != nil {
		s.writeStreamErr(w, err)
	}
}

func (s *Server) handleLogo(w http.ResponseWriter, r *http.Request) {
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	img, err := s.logos.Get(r.Context(), st.ID, st.Favicon)
	if err != nil {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		writeError(w, http.StatusNotFound, "no_logo", "no logo")
		return
	}
	h := w.Header()
	h.Set("Content-Type", img.ContentType)
	h.Set("Cache-Control", "public, max-age=604800")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	_, _ = w.Write(img.Data)
}

func (s *Server) handleClick(w http.ResponseWriter, r *http.Request) {
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	if s.once("click:"+s.clientIP(r)+":"+st.ID, time.Hour) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := s.rb.Click(ctx, st.ID); err != nil {
				s.log.Debug("forward click", "station", st.ID, "err", err)
			}
		}()
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleReport lets clients flag playback failures; it only expedites a
// re-probe, the health checker makes the actual verdict.
func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	st, ok := s.station(w, r)
	if !ok {
		return
	}
	var body struct {
		Kind string `json:"kind"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)
	if body.Kind != "playback_error" && body.Kind != "stalled" {
		writeError(w, http.StatusBadRequest, "bad_kind", "kind must be playback_error or stalled")
		return
	}
	if s.once("report:"+st.ID, 10*time.Minute) {
		go s.checker.ReportFailure(st.ID)
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.HealthStats(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "db_unavailable", err.Error())
		return
	}
	synced := map[string]*time.Time{}
	for _, c := range catalog.Countries {
		if t, err := s.store.LastSuccessfulSync(r.Context(), c); err == nil && !t.IsZero() {
			synced[c] = &t
		} else {
			synced[c] = nil
		}
	}
	cs := s.checker.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"syncedAt": synced,
		"health":   stats,
		"probes":   map[string]any{"total": cs.Probed, "queueDrainedAt": cs.LastDrain},
	})
}
