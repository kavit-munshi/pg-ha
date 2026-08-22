#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "${test_dir}/run_health.sh" "$@"

if [[ "${RUN_DISRUPTIVE:-false}" == "true" ]]; then
  if [[ "${RUN_LEGACY_WAL_TEST:-false}" == "true" ]]; then
    CONFIRM_WAL_TEST=YES bash "${test_dir}/run_wal_archive_test.sh" "$@"
  fi
  CONFIRM_ROUTING_FAILOVER=YES bash "${test_dir}/run_routing_failover.sh" "$@"
  CONFIRM_DB_FAILOVER=YES bash "${test_dir}/run_db_failover.sh" "$@"
else
  echo "Read-only health tests passed."
  echo "Set RUN_DISRUPTIVE=true to include routing and database failover tests."
fi
