CREATE TABLE stations (
    id           TEXT PRIMARY KEY,           -- Radio Browser stationuuid
    name         TEXT NOT NULL,
    country      TEXT NOT NULL,              -- US | CN
    region_key   TEXT NOT NULL DEFAULT 'other',
    region_name  TEXT NOT NULL DEFAULT '',
    region_en    TEXT NOT NULL DEFAULT '',
    city         TEXT NOT NULL DEFAULT '',
    freq         REAL,                       -- MHz, NULL for internet-only streams
    band         TEXT NOT NULL,              -- fm | net
    tags         TEXT NOT NULL DEFAULT '[]', -- JSON array
    language     TEXT NOT NULL DEFAULT '',
    codec        TEXT NOT NULL DEFAULT '',
    bitrate      INTEGER NOT NULL DEFAULT 0,
    hls          INTEGER NOT NULL DEFAULT 0,
    stream_url   TEXT NOT NULL,
    alternates   TEXT NOT NULL DEFAULT '[]', -- JSON array of mirror URLs for the same station
    homepage     TEXT NOT NULL DEFAULT '',
    favicon      TEXT NOT NULL DEFAULT '',
    clicks       INTEGER NOT NULL DEFAULT 0,
    votes        INTEGER NOT NULL DEFAULT 0,
    search       TEXT NOT NULL DEFAULT '',   -- lowercased haystack for LIKE search (works for CJK)
    synced_at    INTEGER NOT NULL,           -- last time seen upstream
    deleted_at   INTEGER,                    -- gone upstream (soft delete)

    -- health checking
    health        TEXT NOT NULL DEFAULT 'unknown', -- unknown | ok | flaky | dead
    fail_count    INTEGER NOT NULL DEFAULT 0,
    first_fail_at INTEGER,
    last_probe_at INTEGER,
    last_ok_at    INTEGER,
    next_probe_at INTEGER NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    last_error    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_stations_country_region ON stations(country, region_key);
CREATE INDEX idx_stations_country_freq ON stations(country, freq);
CREATE INDEX idx_stations_country_clicks ON stations(country, clicks DESC);
CREATE INDEX idx_stations_next_probe ON stations(next_probe_at);

CREATE TABLE sync_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    country     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    fetched     INTEGER NOT NULL DEFAULT 0,
    kept        INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    error       TEXT NOT NULL DEFAULT ''
);
