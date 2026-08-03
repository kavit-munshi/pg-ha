#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
inventory="${INVENTORY:-${repo_root}/inventories/uat_hosts.ini}"

if [[ "${CONFIRM_DB_FAILOVER:-}" != "YES" ]]; then
  read -r -p "Type DB-FAILOVER to perform two controlled PostgreSQL switchovers: " confirmation
  [[ "${confirmation}" == "DB-FAILOVER" ]] || { echo "Cancelled."; exit 2; }
fi

exec ansible-playbook -i "${inventory}" \
  "${repo_root}/tests/playbooks/db_failover.yml" \
  -e confirm_db_failover=true "$@"
