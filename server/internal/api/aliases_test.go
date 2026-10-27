package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"hotfm/server/internal/config"
	"hotfm/server/internal/store"
)

// aliasServer is a server over a store that already merged "old" into "canon".
func aliasServer(t *testing.T) *Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	freq := 90.3
	if _, err := st.ReplaceCountry(context.Background(), "US", []store.Station{
		{
			ID: "canon", Name: "KEXP", Country: "US", RegionKey: "washington", RegionName: "Washington",
			Band: "fm", Freq: &freq, StreamURL: "https://kexp.example/1", AbsorbedIDs: []string{"old"},
		},
	}, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	return New(Deps{
		Config: &config.Config{},
		Store:  st,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

// aliasDo serves one request through the API and returns its status and body.
func aliasDo(t *testing.T, srv *Server, method, target, body string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	srv.Handler(nil).ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestStationAliasResolves(t *testing.T) {
	srv := aliasServer(t)

	code, body := aliasDo(t, srv, http.MethodGet, "/api/v1/stations/old", "")
	if code != http.StatusOK {
		t.Fatalf("GET alias = %d, body %s", code, body)
	}
	var st stationDTO
	if err := json.Unmarshal([]byte(body), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.ID != "canon" || st.AliasOf != "old" {
		t.Fatalf("station = %+v", st)
	}

	code, body = aliasDo(t, srv, http.MethodGet, "/api/v1/stations/canon", "")
	if code != http.StatusOK || strings.Contains(body, "aliasOf") {
		t.Fatalf("GET canonical = %d, body %s", code, body)
	}

	code, body = aliasDo(t, srv, http.MethodGet, "/api/v1/stations/missing", "")
	if code != http.StatusNotFound || !strings.Contains(body, "station_not_found") {
		t.Fatalf("GET unknown = %d, body %s", code, body)
	}

	code, body = aliasDo(t, srv, http.MethodPost, "/api/v1/stations/batch", `{"ids":["old","canon","missing"]}`)
	if code != http.StatusOK {
		t.Fatalf("POST batch = %d, body %s", code, body)
	}
	var batch struct {
		Items []stationDTO `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &batch); err != nil {
		t.Fatalf("decode batch: %v", err)
	}
	if len(batch.Items) != 2 {
		t.Fatalf("batch items = %+v", batch.Items)
	}
	if batch.Items[0].ID != "canon" || batch.Items[0].AliasOf != "old" {
		t.Fatalf("batch alias item = %+v", batch.Items[0])
	}
	if batch.Items[1].ID != "canon" || batch.Items[1].AliasOf != "" {
		t.Fatalf("batch canonical item = %+v", batch.Items[1])
	}
}
