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

	// AbsorbedIDs lists the raw ids a merge folded into this row. It is written
	// on sync as station aliases and never stored as a column.
	AbsorbedIDs []string
	// AliasOf is set when the station was fetched through an absorbed id: it
	// holds the id the caller asked for. Never a column either.
	AliasOf string
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
	if err := replaceAliases(ctx, tx, stations, ts); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `UPDATE stations SET deleted_at = ? WHERE country = ? AND synced_at < ? AND deleted_at IS NULL`, ts, country, ts)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), tx.Commit()
}

// replaceAliases records the ids that a merge folded into other rows and
// collapses chains (a -> b -> c becomes a -> c). Chains are bounded so a
// pathological cycle cannot loop forever.
func replaceAliases(ctx context.Context, tx *sql.Tx, stations []Station, ts int64) error {
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO station_aliases (old_id, canonical_id, created_at) VALUES (?,?,?)
		ON CONFLICT(old_id) DO UPDATE SET canonical_id=excluded.canonical_id`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	// A published row cannot stay retired: dropping its stale alias keeps a
	// re-merge from chaining the survivor back onto an earlier one.
	del, err := tx.PrepareContext(ctx, `DELETE FROM station_aliases WHERE old_id = ?`)
	if err != nil {
		return err
	}
	defer del.Close()
	for i := range stations {
		if _, err := del.ExecContext(ctx, stations[i].ID); err != nil {
			return err
		}
	}
	for i := range stations {
		st := &stations[i]
		for _, old := range st.AbsorbedIDs {
			if old == "" || old == st.ID {
				continue
			}
			if _, err := stmt.ExecContext(ctx, old, st.ID, ts); err != nil {
				return err
			}
		}
	}
	for range maxAliasHops {
		var pending int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM station_aliases a
			WHERE EXISTS (SELECT 1 FROM station_aliases b WHERE b.old_id = a.canonical_id)`).Scan(&pending); err != nil {
			return err
		}
		if pending == 0 {
			break
		}
		if _, err := tx.ExecContext(ctx, `UPDATE station_aliases
			SET canonical_id = (SELECT a2.canonical_id FROM station_aliases a2 WHERE a2.old_id = station_aliases.canonical_id)
			WHERE canonical_id IN (SELECT old_id FROM station_aliases)`); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM station_aliases WHERE old_id = canonical_id`)
	return err
}

// Purge permanently removes stations that have been gone upstream, or dead,
// for longer than maxAge. Their aliases go with them, so old favourites resolve
// as missing instead of resurrecting a purged row.
func (s *Store) Purge(ctx context.Context, now time.Time, maxAge time.Duration) (int, error) {
	cutoff := now.Add(-maxAge).Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM stations
		WHERE (deleted_at IS NOT NULL AND deleted_at < ?)
		   OR (health = 'dead' AND first_fail_at IS NOT NULL AND first_fail_at < ?)`, cutoff, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if _, err := tx.ExecContext(ctx, `DELETE FROM station_aliases WHERE canonical_id NOT IN (SELECT id FROM stations)`); err != nil {
		return int(n), err
	}
	return int(n), tx.Commit()
}

// ExistingIDs returns the ids a merge may keep as its survivor: rows published
// for a country, soft-deleted ones included, but never an id station_aliases
// already retired. Preferring an absorbed id would let the canonical id flip on
// a later sync and leave favourites pointing at a soft-deleted row.
func (s *Store) ExistingIDs(ctx context.Context, country string) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM stations WHERE country = ?
		AND id NOT IN (SELECT old_id FROM station_aliases)`, country)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// maxAliasHops bounds alias chain walking and collapsing.
const maxAliasHops = 5

// aliasTarget follows station_aliases to the surviving id. It returns
// ErrNotFound when id is not an alias.
func (s *Store) aliasTarget(ctx context.Context, id string) (string, error) {
	current, found := id, false
	for range maxAliasHops {
		var canonical string
		err := s.db.QueryRowContext(ctx, "SELECT canonical_id FROM station_aliases WHERE old_id = ?", current).Scan(&canonical)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			return "", err
		}
		if canonical == current {
			break
		}
		current, found = canonical, true
	}
	if !found {
		return "", ErrNotFound
	}
	return current, nil
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

// stationRow loads one station regardless of its visibility.
func (s *Store) stationRow(ctx context.Context, id string) (*Station, error) {
	st, err := scanStation(s.db.QueryRowContext(ctx, "SELECT "+stationCols+" FROM stations WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return st, err
}

func (s *Store) stationsByIDs(ctx context.Context, ids []string) (map[string]*Station, error) {
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
	m := make(map[string]*Station, len(found))
	for _, st := range found {
		m[st.ID] = st
	}
	return m, nil
}

// GetStation loads a station by id. An id that a merge absorbed (and whose own
// row is gone or soft deleted) resolves to the surviving station, which then
// carries the requested id in AliasOf.
func (s *Store) GetStation(ctx context.Context, id string) (*Station, error) {
	st, err := s.stationRow(ctx, id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if err == nil && st.DeletedAt == nil {
		return st, nil
	}
	canonical, aerr := s.aliasTarget(ctx, id)
	if aerr == nil {
		target, terr := s.stationRow(ctx, canonical)
		if terr != nil {
			return nil, terr
		}
		target.AliasOf = id
		return target, nil
	}
	if !errors.Is(aerr, ErrNotFound) {
		return nil, aerr
	}
	if st == nil {
		return nil, ErrNotFound
	}
	return st, nil
}

// GetStations returns the stations that still exist (including dead or
// deleted ones, so clients can show them as offline), in the order of ids.
// Ids absorbed by a merge resolve to the surviving station.
func (s *Store) GetStations(ctx context.Context, ids []string) ([]*Station, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	byID, err := s.stationsByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	// Rows that are missing or were soft deleted by a merge may be aliases.
	var strays []string
	for _, id := range ids {
		if st, ok := byID[id]; !ok || st.DeletedAt != nil {
			strays = append(strays, id)
		}
	}
	resolved := make(map[string]string, len(strays))
	if len(strays) > 0 {
		var targets []string
		for _, id := range strays {
			canonical, aerr := s.aliasTarget(ctx, id)
			if errors.Is(aerr, ErrNotFound) {
				continue
			}
			if aerr != nil {
				return nil, aerr
			}
			resolved[id] = canonical
			if _, ok := byID[canonical]; !ok {
				targets = append(targets, canonical)
			}
		}
		if len(targets) > 0 {
			more, merr := s.stationsByIDs(ctx, targets)
			if merr != nil {
				return nil, merr
			}
			for id, st := range more {
				byID[id] = st
			}
		}
	}
	out := make([]*Station, 0, len(ids))
	for _, id := range ids {
		if st, ok := byID[id]; ok && st.DeletedAt == nil {
			out = append(out, st)
			continue
		}
		if canonical, ok := resolved[id]; ok {
			if st, ok := byID[canonical]; ok {
				// A copy, because the same canonical station may answer several ids.
				cp := *st
				cp.AliasOf = id
				out = append(out, &cp)
			}
			continue
		}
		// Soft deleted without an alias: still reported so clients show it offline.
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
