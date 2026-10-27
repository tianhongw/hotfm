package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"hotfm/server/internal/config"
	"hotfm/server/internal/logo"
	"hotfm/server/internal/netguard"
	"hotfm/server/internal/store"
	"hotfm/server/internal/webui"
)

// perfStaticServer mimics webui.Handler: the stdlib derives Content-Type,
// Content-Length, Accept-Ranges and 206 handling from the name and body.
func perfStaticServer(name string, body []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
	})
}

func perfGunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	return out
}

func TestPerfStaticGzipJS(t *testing.T) {
	body := bytes.Repeat([]byte("console.log('hotfm');\n"), 200)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	staticGzip(perfStaticServer("index-abc.js", body)).ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if got := res.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	if got := res.Header.Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q, want unset (uncompressed value is wrong)", got)
	}
	if got := perfGunzip(t, rec.Body.Bytes()); !bytes.Equal(got, body) {
		t.Errorf("gunzipped body mismatch: got %d bytes, want %d", len(got), len(body))
	}
}

func TestPerfStaticGzipHTML(t *testing.T) {
	body := []byte("<!doctype html><html><body><div id=\"root\"></div></body></html>")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/settings", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	staticGzip(perfStaticServer("index.html", body)).ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if got := perfGunzip(t, rec.Body.Bytes()); !bytes.Equal(got, body) {
		t.Errorf("SPA index body mismatch")
	}
}

func TestPerfStaticGzipSkipsFonts(t *testing.T) {
	body := append([]byte("wOF2"), bytes.Repeat([]byte{0x00, 0x01}, 256)...)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/font-abc.woff2", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	staticGzip(perfStaticServer("font-abc.woff2", body)).ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none", got)
	}
	if got, want := rec.Header().Get("Content-Length"), "516"; got != want {
		t.Errorf("Content-Length = %q, want %q", got, want)
	}
	if !bytes.Equal(rec.Body.Bytes(), body) {
		t.Errorf("body was modified")
	}
}

func TestPerfStaticGzipNoAcceptEncoding(t *testing.T) {
	body := bytes.Repeat([]byte("body{}"), 64)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc.js", nil)
	staticGzip(perfStaticServer("index-abc.js", body)).ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), body) {
		t.Errorf("body was modified")
	}
}

func TestPerfStaticGzipHeadHasNoBodyLength(t *testing.T) {
	body := bytes.Repeat([]byte("body{}"), 64)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodHead, "/assets/index-abc.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	staticGzip(perfStaticServer("index-abc.js", body)).ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	// A compressed HEAD must not advertise the empty gzip member (23 bytes)
	// while the matching GET has no length at all.
	if got := rec.Header().Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q, want none", got)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
}

func TestPerfStaticGzipRangeUntouched(t *testing.T) {
	body := bytes.Repeat([]byte("0123456789"), 10)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-9")
	staticGzip(perfStaticServer("index-abc.js", body)).ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", res.StatusCode)
	}
	if got := res.Header.Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none on 206", got)
	}
	if got, want := res.Header.Get("Content-Range"), "bytes 0-9/100"; got != want {
		t.Errorf("Content-Range = %q, want %q", got, want)
	}
	if got, want := res.Header.Get("Content-Length"), "10"; got != want {
		t.Errorf("Content-Length = %q, want %q", got, want)
	}
	if !bytes.Equal(rec.Body.Bytes(), body[:10]) {
		t.Errorf("range body = %q, want %q", rec.Body.Bytes(), body[:10])
	}
}

func TestPerfStaticGzipNon200Passthrough(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("missing\n"))
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/nope", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	staticGzip(handler).ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none on 404", got)
	}
	if got := rec.Body.String(); got != "missing\n" {
		t.Errorf("body = %q, want %q", got, "missing\n")
	}
}

func TestPerfStaticGzipRealHandler(t *testing.T) {
	s := New(Deps{Config: &config.Config{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	h := s.Handler(webui.Handler())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	h.ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", got)
	}
	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if !strings.HasPrefix(string(perfGunzip(t, rec.Body.Bytes())), "<!doctype html") {
		t.Errorf("SPA index body was not served")
	}
}

// --- JSON ETag middleware ---

func perfJSONPayload() map[string]any {
	return map[string]any{"items": []map[string]any{{"id": "a", "name": "A"}, {"id": "b", "name": "B"}}}
}

func perfJSONHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, perfJSONPayload())
	}
}

func perfGet(t *testing.T, h http.Handler, method string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, "/api/v1/stations", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(rec, req)
	return rec
}

var perfETagRe = regexp.MustCompile(`^W/"[0-9a-f]{16}"$`)

func TestPerfJSONETagSet(t *testing.T) {
	h := jsonResponse(perfJSONHandler())
	rec := perfGet(t, h, http.MethodGet, map[string]string{"Accept-Encoding": "gzip"})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("ETag"); !perfETagRe.MatchString(got) {
		t.Errorf("ETag = %q, want weak 16-hex tag", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
}

func TestPerfJSONETagRevalidation(t *testing.T) {
	h := jsonResponse(perfJSONHandler())
	first := perfGet(t, h, http.MethodGet, map[string]string{"Accept-Encoding": "gzip"})
	etag := first.Header().Get("ETag")

	for _, inm := range []string{etag, "*", `"other", ` + etag, `W/"other", ` + strings.TrimPrefix(etag, "W/")} {
		t.Run(inm, func(t *testing.T) {
			rec := perfGet(t, h, http.MethodGet, map[string]string{
				"Accept-Encoding": "gzip",
				"If-None-Match":   inm,
			})
			if rec.Code != http.StatusNotModified {
				t.Fatalf("status = %d, want 304", rec.Code)
			}
			if rec.Body.Len() != 0 {
				t.Errorf("304 body = %q, want empty", rec.Body.String())
			}
			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none on 304", got)
			}
			if got := rec.Header().Get("Content-Length"); got != "" {
				t.Errorf("Content-Length = %q, want none on 304", got)
			}
			if got := rec.Header().Get("ETag"); got != etag {
				t.Errorf("304 ETag = %q, want %q", got, etag)
			}
		})
	}
}

func TestPerfJSONETagNonMatching(t *testing.T) {
	h := jsonResponse(perfJSONHandler())
	rec := perfGet(t, h, http.MethodGet, map[string]string{
		"Accept-Encoding": "gzip",
		"If-None-Match":   `W/"0000000000000000"`,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if perfGunzip(t, rec.Body.Bytes()) == nil {
		t.Fatal("missing body")
	}
}

func TestPerfJSONGzipMatchesIdentity(t *testing.T) {
	payload := perfJSONPayload()
	h := func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, payload) }

	raw := perfGet(t, jsonResponse(h), http.MethodGet, nil)
	gz := perfGet(t, jsonResponse(h), http.MethodGet, map[string]string{"Accept-Encoding": "gzip"})

	if got, want := raw.Header().Get("Content-Length"), strconv.Itoa(raw.Body.Len()); got != want {
		t.Errorf("identity Content-Length = %q, want %q", got, want)
	}
	if got := raw.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("identity Content-Encoding = %q, want none", got)
	}
	var want, got any
	if err := json.Unmarshal(raw.Body.Bytes(), &want); err != nil {
		t.Fatalf("identity body: %v", err)
	}
	if err := json.Unmarshal(perfGunzip(t, gz.Body.Bytes()), &got); err != nil {
		t.Fatalf("gzip body: %v", err)
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if !bytes.Equal(wantJSON, gotJSON) {
		t.Errorf("gzip body %s != identity body %s", gotJSON, wantJSON)
	}
	if got, wantTag := raw.Header().Get("ETag"), gz.Header().Get("ETag"); got != wantTag {
		t.Errorf("ETag differs by encoding: %q vs %q", got, wantTag)
	}
}

func TestPerfJSONETagOnlyForGet200(t *testing.T) {
	post := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, perfJSONPayload())
	}
	rec := perfGet(t, jsonResponse(post), http.MethodPost, map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("ETag"); got != "" {
		t.Errorf("POST ETag = %q, want none", got)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("POST Content-Encoding = %q, want gzip", got)
	}
	if perfGunzip(t, rec.Body.Bytes()) == nil {
		t.Error("POST body missing")
	}

	fourOhFour := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "station_not_found", "station not found")
	}
	rec = perfGet(t, jsonResponse(fourOhFour), http.MethodGet, map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("ETag"); got != "" {
		t.Errorf("404 ETag = %q, want none", got)
	}
	var body errorBody
	if err := json.Unmarshal(perfGunzip(t, rec.Body.Bytes()), &body); err != nil {
		t.Fatalf("404 body: %v", err)
	}
	if body.Error.Code != "station_not_found" {
		t.Errorf("404 body = %+v", body)
	}
}

func TestPerfJSONHead(t *testing.T) {
	h := jsonResponse(perfJSONHandler())
	rec := perfGet(t, h, http.MethodHead, map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
	if got := rec.Header().Get("ETag"); !perfETagRe.MatchString(got) {
		t.Errorf("HEAD ETag = %q", got)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("HEAD Content-Encoding = %q, want gzip", got)
	}
}

// TestPerfJSONETagAPIWiring checks that a real GET route is served through the
// ETag middleware and revalidates to 304 on a second request.
func TestPerfJSONETagAPIWiring(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	s := New(Deps{Config: &config.Config{}, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	h := s.Handler(nil)

	first := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/countries", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	h.ServeHTTP(first, req)
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if !perfETagRe.MatchString(etag) {
		t.Fatalf("ETag = %q", etag)
	}
	if got := first.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if len(perfGunzip(t, first.Body.Bytes())) == 0 {
		t.Fatal("empty body")
	}

	second := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/countries", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("If-None-Match", etag)
	h.ServeHTTP(second, req)
	if second.Code != http.StatusNotModified {
		t.Fatalf("revalidation status = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Errorf("304 body = %q, want empty", second.Body.String())
	}
	if got := second.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("304 Content-Encoding = %q, want none", got)
	}
}

// TestPerfLogoMissTTL checks that the logo handler tells browsers to retry soon
// after a transient upstream failure but not after a definitive miss.
func TestPerfLogoMissTTL(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   string
	}{
		{"transient", http.StatusInternalServerError, "public, max-age=300"},
		{"definitive", http.StatusNotFound, "public, max-age=86400"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer up.Close()

			st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
			if err != nil {
				t.Fatalf("open store: %v", err)
			}
			t.Cleanup(func() { _ = st.Close() })
			ctx := context.Background()
			if _, err := st.ReplaceCountry(ctx, "US", []store.Station{{
				ID: "perf-logo-1", Name: "Logo Test", Country: "US", RegionKey: "other",
				StreamURL: up.URL + "/stream", Favicon: up.URL + "/favicon.ico",
			}}, time.Now()); err != nil {
				t.Fatalf("replace stations: %v", err)
			}

			s := New(Deps{
				Config: &config.Config{},
				Store:  st,
				Logos: &logo.Cache{
					Dir:       t.TempDir(),
					Client:    netguard.NewClient(netguard.Options{AllowPrivate: true}),
					UserAgent: "test",
				},
				Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/v1/logo/perf-logo-1", nil)
			s.Handler(nil).ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Cache-Control"); got != tc.want {
				t.Errorf("Cache-Control = %q, want %q", got, tc.want)
			}
		})
	}
}
