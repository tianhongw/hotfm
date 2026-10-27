package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"hotfm/server/internal/config"
	"hotfm/server/internal/store"
)

// countriesFakeSync is a SyncStatus whose per-country state is fixed.
type countriesFakeSync map[string]bool

func (f countriesFakeSync) Syncing(country string) bool { return f[country] }

type countriesItem struct {
	Code     string  `json:"code"`
	Count    int     `json:"count"`
	Syncing  bool    `json:"syncing"`
	SyncedAt *string `json:"syncedAt"`
}

type countriesBody struct {
	Items []countriesItem `json:"items"`
}

// countriesGet serves one GET /api/v1/countries through a fresh server.
func countriesGet(t *testing.T, sync SyncStatus) countriesBody {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return countriesGetFrom(t, st, sync)
}

func countriesGetFrom(t *testing.T, st *store.Store, sync SyncStatus) countriesBody {
	t.Helper()
	srv := New(Deps{
		Config: &config.Config{},
		Store:  st,
		Sync:   sync,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/countries", nil)
	srv.Handler(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /countries = %d, body %s", rec.Code, rec.Body.String())
	}
	var body countriesBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v (%s)", err, rec.Body.String())
	}
	if len(body.Items) != 2 {
		t.Fatalf("got %d countries, want 2: %s", len(body.Items), rec.Body.String())
	}
	return body
}

func TestHandleCountriesReportsSyncing(t *testing.T) {
	t.Run("running sync", func(t *testing.T) {
		body := countriesGet(t, countriesFakeSync{"US": true})
		if got := body.Items[0]; got.Code != "US" || got.Count != 0 || !got.Syncing || got.SyncedAt != nil {
			t.Fatalf("US = %+v, want {code:US count:0 syncing:true syncedAt:nil}", got)
		}
		if got := body.Items[1]; got.Code != "CN" || got.Syncing {
			t.Fatalf("CN = %+v, want syncing:false", got)
		}
	})

	t.Run("no sync status dep", func(t *testing.T) {
		body := countriesGet(t, nil)
		for _, it := range body.Items {
			if it.Syncing {
				t.Fatalf("%s syncing:true without a Sync dep: %+v", it.Code, it)
			}
		}
	})

	t.Run("synced country", func(t *testing.T) {
		st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
		if err != nil {
			t.Fatalf("open store: %v", err)
		}
		t.Cleanup(func() { _ = st.Close() })
		ctx := context.Background()
		id, err := st.StartSyncRun(ctx, "CN", time.Now().Add(-time.Minute))
		if err != nil {
			t.Fatalf("StartSyncRun: %v", err)
		}
		if err := st.FinishSyncRun(ctx, id, 0, 0, 0, nil, time.Now()); err != nil {
			t.Fatalf("FinishSyncRun: %v", err)
		}

		body := countriesGetFrom(t, st, countriesFakeSync{})
		if body.Items[0].SyncedAt != nil {
			t.Fatalf("US syncedAt = %v, want nil", *body.Items[0].SyncedAt)
		}
		if body.Items[1].SyncedAt == nil {
			t.Fatalf("CN syncedAt = nil, want a timestamp: %+v", body.Items[1])
		}
	})
}
