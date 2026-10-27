-- Radio Browser uuids absorbed by a duplicate merge, so old favourites and
-- deep links keep resolving to the surviving row.
CREATE TABLE station_aliases (
    old_id       TEXT PRIMARY KEY,   -- Radio Browser uuid absorbed by a merge
    canonical_id TEXT NOT NULL,      -- stations.id of the surviving row
    created_at   INTEGER NOT NULL
);

CREATE INDEX idx_station_aliases_canonical ON station_aliases(canonical_id);