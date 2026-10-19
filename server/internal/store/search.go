package store

import (
	"context"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Search the entire visible catalog within the requested filters before paging.
// Only small search fields are scanned; full station records are fetched for the
// requested page. The existing search column works without a re-sync or migration.
func (s *Store) searchStations(ctx context.Context, q Query) ([]*Station, int, error) {
	where, args := q.where()
	rows, err := s.db.QueryContext(ctx, "SELECT id, name, search FROM stations WHERE "+where+" ORDER BY "+q.orderBy(), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	type match struct {
		id    string
		score int
	}
	var matches []match
	query := newStationSearch(q.Q)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}
		var id, name, metadata string
		if err := rows.Scan(&id, &name, &metadata); err != nil {
			return nil, 0, err
		}
		if score := query.score(name, metadata); score >= 0 {
			matches = append(matches, match{id, score})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	// Relevance leads for the default sort; popularity breaks ties. Explicit
	// frequency/name sorts retain their requested ordering across all matches.
	if q.Sort != "freq" && q.Sort != "name" {
		sort.SliceStable(matches, func(i, j int) bool { return matches[i].score < matches[j].score })
	}
	total := len(matches)
	start := min(max(q.Offset, 0), total)
	end := total
	if q.Limit >= 0 {
		end = start + min(q.Limit, total-start)
	}
	ids := make([]string, 0, end-start)
	for _, m := range matches[start:end] {
		ids = append(ids, m.id)
	}
	items, err := s.GetStations(ctx, ids)
	return items, total, err
}

type stationSearch struct {
	text, compact string
	terms         []string
}

func newStationSearch(query string) stationSearch {
	text := normalizeSearch(query)
	return stationSearch{text, strings.ReplaceAll(text, " ", ""), strings.Fields(text)}
}

// Fold case/accents and punctuation boundaries (K-EXP, K EXP, KEXP). SQL
// wildcard characters stay literal, so '%' or '_' never match the whole catalog.
func normalizeSearch(text string) string {
	var out strings.Builder
	for _, r := range norm.NFKD.String(text) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case unicode.IsLetter(r), unicode.IsNumber(r), r == '%', r == '_', r == '\\':
			out.WriteRune(unicode.ToLower(r))
		default:
			out.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(out.String()), " ")
}

func (q stationSearch) score(name, metadata string) int {
	if q.compact == "" {
		return -1
	}
	name = normalizeSearch(name)
	compact := strings.ReplaceAll(name, " ", "")
	if compact == q.compact {
		return 0
	}
	if strings.Contains(compact, q.compact) {
		return 1
	}
	if containsTerms(name, q.terms) {
		return 2
	}
	metadata = normalizeSearch(metadata)
	if containsTerms(metadata, q.terms) {
		return 3
	}
	words := strings.Fields(name)
	// Also tolerate a typo in a multiword name entered without spaces.
	if distance := typoDistance(q.compact, compact); distance >= 0 {
		return 4 + distance
	}
	distance := 0
	for _, term := range q.terms {
		if strings.Contains(metadata, term) {
			continue
		}
		best := -1
		for _, word := range words {
			if d := typoDistance(term, word); d >= 0 && (best < 0 || d < best) {
				best = d
			}
		}
		if best < 0 {
			return -1
		}
		distance += best
	}
	return 4 + distance
}

func containsTerms(text string, terms []string) bool {
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}

// Keep short names, numbers and Chinese fragments precise. Latin words of
// 4–7 letters allow one edit; longer words allow two, including transpositions.
func typoDistance(query, word string) int {
	if len(query) < 4 || len(query) > 64 {
		return -1
	}
	for _, c := range query {
		if c < 'a' || c > 'z' {
			return -1
		}
	}
	limit := 1
	if len(query) >= 8 {
		limit = 2
	}
	if len(word) < len(query)-limit || len(word) > len(query)+limit {
		return -1
	}
	// Optimal string alignment distance, using three rows for adjacent swaps.
	var previous, current, beforePrevious [67]int
	for j := 0; j <= len(word); j++ {
		previous[j] = j
	}
	for i := 1; i <= len(query); i++ {
		current[0] = i
		for j := 1; j <= len(word); j++ {
			cost := 1
			if query[i-1] == word[j-1] {
				cost = 0
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
			if i > 1 && j > 1 && query[i-1] == word[j-2] && query[i-2] == word[j-1] {
				current[j] = min(current[j], beforePrevious[j-2]+1)
			}
		}
		beforePrevious, previous, current = previous, current, beforePrevious
	}
	if distance := previous[len(word)]; distance <= limit {
		return distance
	}
	return -1
}
