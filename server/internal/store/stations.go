package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

var ErrNotFound = errors.New("not found")

// Health states. See package health for the transitions.
const (
	HealthUnknown = "unknown"
	HealthOK      = "ok"
	HealthFlaky   = "flaky"
	HealthDead    = "dead"
)

type Station struct {
	ID         string
	Name       string
	Country    string
	RegionKey  string
	RegionName string
	RegionEn   string
	City       string
	Freq       *float64
	Band       string
	Tags       []string
	Language   string
	Codec      string
	Bitrate    int
	HLS        bool
	StreamURL  string
	Alternates []string
	Homepage   string
	Favicon    string
	Clicks     int
	Votes      int
	DeletedAt  *int64
	Health     string
	LastOKAt   *int64
}

// Visible reports whether the station should appear in listings.
func (s *Station) Visible() bool { return s.DeletedAt == nil && s.Health != HealthDead }

const stationCols = `id, name, country, region_key, region_name, region_en, city, freq, band, tags, language,
	codec, bitrate, hls, stream_url, alternates, homepage, favicon, clicks, votes, deleted_at, health, last_ok_at`

// visibleWhere filters out stations that vanished upstream or failed health checks.
const visibleWhere = `deleted_at IS NULL AND health != 'dead'`

type scanner interface{ Scan(...any) error }

func scanStation(r scanner) (*Station, error) {
	var (
		st   Station
		freq sql.NullFloat64
		tags string
		alts string
		hls  int
		del  sql.NullInt64
		ok   sql.NullInt64
	)
	if err := r.Scan(&st.ID, &st.Name, &st.Country, &st.RegionKey, &st.RegionName, &st.RegionEn, &st.City,
		&freq, &st.Band, &tags, &st.Language, &st.Codec, &st.Bitrate, &hls, &st.StreamURL, &alts, &st.Homepage,
		&st.Favicon, &st.Clicks, &st.Votes, &del, &st.Health, &ok); err != nil {
		return nil, err
	}
	if freq.Valid {
		st.Freq = &freq.Float64
	}
	if del.Valid {
		st.DeletedAt = &del.Int64
	}
	if ok.Valid {
		st.LastOKAt = &ok.Int64
	}
	st.HLS = hls == 1
	_ = json.Unmarshal([]byte(tags), &st.Tags)
	if st.Tags == nil {
		st.Tags = []string{}
	}
	_ = json.Unmarshal([]byte(alts), &st.Alternates)
	return &st, nil
}

// ReplaceCountry upserts the freshly synced stations of a country and soft
// deletes rows that disappeared upstream. Health data is preserved unless the
// stream URL changed, in which case the station is re-probed from scratch.
func (s *Store) ReplaceCountry(ctx context.Context, country string, stations []Station, now time.Time) (removed int, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
INSERT INTO stations (id, name, country, region_key, region_name, region_en, city, freq, band, tags, language,
	codec, bitrate, hls, stream_url, alternates, homepage, favicon, clicks, votes, search, synced_at, deleted_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
ON CONFLICT(id) DO UPDATE SET
	name=excluded.name, country=excluded.country, region_key=excluded.region_key,
	region_name=excluded.region_name, region_en=excluded.region_en, city=excluded.city,
	freq=excluded.freq, band=excluded.band, tags=excluded.tags, language=excluded.language,
	codec=excluded.codec, bitrate=excluded.bitrate, hls=excluded.hls, homepage=excluded.homepage,
	favicon=excluded.favicon, clicks=excluded.clicks, votes=excluded.votes, search=excluded.search,
	synced_at=excluded.synced_at, deleted_at=NULL,
	health        = CASE WHEN stations.stream_url = excluded.stream_url THEN stations.health ELSE 'unknown' END,
	fail_count    = CASE WHEN stations.stream_url = excluded.stream_url THEN stations.fail_count ELSE 0 END,
	first_fail_at = CASE WHEN stations.stream_url = excluded.stream_url THEN stations.first_fail_at ELSE NULL END,
	next_probe_at = CASE WHEN stations.stream_url = excluded.stream_url THEN stations.next_probe_at ELSE 0 END,
	stream_url=excluded.stream_url, alternates=excluded.alternates`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()

	ts := now.Unix()
	for i := range stations {
		st := &stations[i]
		tags, _ := json.Marshal(st.Tags)
		alts, _ := json.Marshal(st.Alternates)
		var freq any
		if st.Freq != nil {
			freq = *st.Freq
		}
		hls := 0
		if st.HLS {
			hls = 1
		}
		search := strings.ToLower(strings.Join([]string{st.Name, strings.Join(st.Tags, " "), st.City, st.RegionName, st.RegionEn}, " "))
		if _, err := stmt.ExecContext(ctx, st.ID, st.Name, country, st.RegionKey, st.RegionName, st.RegionEn, st.City,
			freq, st.Band, string(tags), st.Language, st.Codec, st.Bitrate, hls, st.StreamURL, string(alts), st.Homepage,
			st.Favicon, st.Clicks, st.Votes, search, ts); err != nil {
			return 0, err
		}
	}
	res, err := tx.ExecContext(ctx, `UPDATE stations SET deleted_at = ? WHERE country = ? AND synced_at < ? AND deleted_at IS NULL`, ts, country, ts)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), tx.Commit()
}

// Purge permanently removes stations that have been gone upstream, or dead,
// for longer than maxAge. Favourites pointing at them then resolve as missing.
func (s *Store) Purge(ctx context.Context, now time.Time, maxAge time.Duration) (int, error) {
	cutoff := now.Add(-maxAge).Unix()
	res, err := s.db.ExecContext(ctx, `DELETE FROM stations
		WHERE (deleted_at IS NOT NULL AND deleted_at < ?)
		   OR (health = 'dead' AND first_fail_at IS NOT NULL AND first_fail_at < ?)`, cutoff, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

type Query struct {
	Country string
	Region  string
	Tag     string
	Band    string // "", fm, net
	Freq    *float64
	Q       string
	Sort    string // popular | freq | name
	Offset  int
	Limit   int
}

func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(strings.ToLower(s)) + "%"
}

func (q Query) where() (string, []any) {
	conds := []string{visibleWhere}
	var args []any
	if q.Country != "" {
		conds = append(conds, "country = ?")
		args = append(args, q.Country)
	}
	if q.Region != "" {
		conds = append(conds, "region_key = ?")
		args = append(args, q.Region)
	}
	if q.Band != "" {
		conds = append(conds, "band = ?")
		args = append(args, q.Band)
	}
	if q.Freq != nil {
		conds = append(conds, "ABS(freq - ?) < 0.05")
		args = append(args, *q.Freq)
	}
	if q.Tag != "" {
		b, _ := json.Marshal(strings.ToLower(q.Tag))
		conds = append(conds, `tags LIKE ? ESCAPE '\'`)
		args = append(args, likeEscape(string(b)))
	}
	return strings.Join(conds, " AND "), args
}

func (q Query) orderBy() string {
	switch q.Sort {
	case "freq":
		return "freq IS NULL, freq, clicks DESC, id"
	case "name":
		return "name COLLATE NOCASE, id"
	default:
		// Flaky stations sink below healthy ones of similar popularity.
		return "(health = 'flaky'), clicks DESC, id"
	}
}

func (s *Store) ListStations(ctx context.Context, q Query) ([]*Station, int, error) {
	if strings.TrimSpace(q.Q) != "" {
		return s.searchStations(ctx, q)
	}
	where, args := q.where()
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM stations WHERE "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+stationCols+" FROM stations WHERE "+where+
		" ORDER BY "+q.orderBy()+" LIMIT ? OFFSET ?", append(args, q.Limit, q.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out, err := collect(rows)
	return out, total, err
}

func collect(rows *sql.Rows) ([]*Station, error) {
	var out []*Station
	for rows.Next() {
		st, err := scanStation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *Store) GetStation(ctx context.Context, id string) (*Station, error) {
	st, err := scanStation(s.db.QueryRowContext(ctx, "SELECT "+stationCols+" FROM stations WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return st, err
}

// GetStations returns the stations that still exist (including dead or
// deleted ones, so clients can show them as offline), in the order of ids.
func (s *Store) GetStations(ctx context.Context, ids []string) ([]*Station, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+stationCols+" FROM stations WHERE id IN ("+ph+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found, err := collect(rows)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*Station, len(found))
	for _, st := range found {
		byID[st.ID] = st
	}
	out := make([]*Station, 0, len(found))
	for _, id := range ids {
		if st, ok := byID[id]; ok {
			out = append(out, st)
		}
	}
	return out, nil
}

// DialStations returns visible FM stations ordered by frequency then popularity.
func (s *Store) DialStations(ctx context.Context, country, region string) ([]*Station, error) {
	q := "SELECT " + stationCols + " FROM stations WHERE " + visibleWhere + " AND country = ? AND freq IS NOT NULL"
	args := []any{country}
	if region != "" {
		q += " AND region_key = ?"
		args = append(args, region)
	}
	rows, err := s.db.QueryContext(ctx, q+" ORDER BY freq, (health = 'flaky'), clicks DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collect(rows)
}

type CountryCount struct {
	Code  string
	Count int
}

func (s *Store) Countries(ctx context.Context) ([]CountryCount, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT country, count(*) FROM stations WHERE "+visibleWhere+" GROUP BY country")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CountryCount
	for rows.Next() {
		var c CountryCount
		if err := rows.Scan(&c.Code, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type RegionCount struct {
	Key, Name, NameEn string
	Count, FMCount    int
}

func (s *Store) Regions(ctx context.Context, country string) ([]RegionCount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT region_key, max(region_name), max(region_en), count(*), count(freq)
		FROM stations WHERE `+visibleWhere+` AND country = ? GROUP BY region_key
		ORDER BY region_key = 'other', count(*) DESC`, country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RegionCount
	for rows.Next() {
		var r RegionCount
		if err := rows.Scan(&r.Key, &r.Name, &r.NameEn, &r.Count, &r.FMCount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type TagCount struct {
	Tag   string
	Count int
}

// Tags returns the most common tags among visible stations of a country/region.
func (s *Store) Tags(ctx context.Context, country, region string, limit int) ([]TagCount, error) {
	q := "SELECT tags FROM stations WHERE " + visibleWhere + " AND country = ?"
	args := []any{country}
	if region != "" {
		q += " AND region_key = ?"
		args = append(args, region)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var tags []string
		_ = json.Unmarshal([]byte(raw), &tags)
		for _, t := range tags {
			counts[t]++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]TagCount, 0, len(counts))
	for t, c := range counts {
		if c >= 3 {
			out = append(out, TagCount{t, c})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// --- sync bookkeeping ---

func (s *Store) StartSyncRun(ctx context.Context, country string, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, "INSERT INTO sync_runs (country, started_at) VALUES (?, ?)", country, now.Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) FinishSyncRun(ctx context.Context, id int64, fetched, kept, removed int, runErr error, now time.Time) error {
	msg := ""
	if runErr != nil {
		msg = runErr.Error()
	}
	_, err := s.db.ExecContext(ctx, "UPDATE sync_runs SET finished_at=?, fetched=?, kept=?, removed=?, error=? WHERE id=?",
		now.Unix(), fetched, kept, removed, msg, id)
	return err
}

// LastSuccessfulSync returns the finish time of the latest error-free run for a country.
func (s *Store) LastSuccessfulSync(ctx context.Context, country string) (time.Time, error) {
	var ts sql.NullInt64
	err := s.db.QueryRowContext(ctx, "SELECT max(finished_at) FROM sync_runs WHERE country = ? AND error = '' AND finished_at IS NOT NULL", country).Scan(&ts)
	if err != nil || !ts.Valid {
		return time.Time{}, err
	}
	return time.Unix(ts.Int64, 0), nil
}

// StreamURLs returns id -> current stream URL for a country, so a re-sync can
// keep a mirror that the health checker promoted.
func (s *Store) StreamURLs(ctx context.Context, country string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, stream_url FROM stations WHERE country = ? AND health IN ('ok', 'flaky')", country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, u string
		if err := rows.Scan(&id, &u); err != nil {
			return nil, err
		}
		out[id] = u
	}
	return out, rows.Err()
}
