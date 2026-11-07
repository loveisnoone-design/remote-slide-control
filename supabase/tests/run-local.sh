#!/usr/bin/env bash
# Runs the migration and access-rule tests against a throwaway local Postgres.
# Needs Postgres 15+ server binaries (initdb, pg_ctl) on PATH or PG_BIN set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
WORK="$(mktemp -d)"
DATA="$WORK/data"
SOCK="$WORK/sock"
PORT="${PGPORT_TEST:-54329}"
mkdir -p "$SOCK"

cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$HERE/stub_supabase.sql"
for f in "$HERE"/../migrations/*.sql; do
  "${PSQL[@]}" -f "$f"
done
"${PSQL[@]}" -o /dev/null -f "$HERE/policies.test.sql"
