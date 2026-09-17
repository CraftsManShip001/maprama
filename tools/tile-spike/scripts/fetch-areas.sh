#!/usr/bin/env bash
# Fetches the small OSM areas the tile spike measures density with.
#
#   bash tools/tile-spike/scripts/fetch-areas.sh
#
# Each bbox is about 1 km², which keeps Overpass happy; already-fetched areas are
# skipped. Output goes to tools/tile-spike/.data (gitignored): a world built from
# OSM is ODbL, not Apache-2.0, so it must not be committed.
#
# Requires `npm run build -w @maprama/protocol && npm run build -w @maprama/osm`.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SPIKE=$(dirname "$HERE")
REPO=$(cd "$SPIKE/../.." && pwd)
OSM="$REPO/tools/osm"
OUT="$SPIKE/.data"
mkdir -p "$OUT"

fetch_one() {
  name=$1; bbox=$2; label=$3
  if [ -f "$OUT/$name.world.json" ]; then echo "skip $name"; return; fi
  echo "=== $name $bbox"
  node "$OSM/dist/bin.js" fetch --bbox "$bbox" --out "$OUT/$name.raw.json" --timeout 120 \
    || { echo "FETCH FAIL $name"; return; }
  node "$OSM/dist/bin.js" build --raw "$OUT/$name.raw.json" --out "$OUT/$name.world.json" --name "$label" \
    || echo "BUILD FAIL $name"
  sleep 8
}

#         name       bbox (s,w,n,e)                      label
fetch_one gangnam    37.4950,127.0250,37.5040,127.0370  "Gangnam, Seoul"
fetch_one bundang    37.3520,127.1050,37.3610,127.1170  "Bundang, Seongnam"
fetch_one busan      35.1550,129.0500,35.1640,129.0620  "Seomyeon, Busan"
fetch_one gurye      35.2000,127.4580,35.2090,127.4700  "Gurye"
fetch_one farmland   35.8000,126.9000,35.8090,126.9120  "Gimje farmland"
fetch_one mountain   37.7500,128.5500,37.7590,128.5620  "Odaesan"
fetch_one hangang    37.5150,126.9900,37.5240,127.0020  "Hangang, Seoul"

echo "=== done"
ls -la "$OUT"/*.world.json
