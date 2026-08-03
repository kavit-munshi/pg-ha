#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
inventory="${INVENTORY:-${repo_root}/inventories/uat_hosts.ini}"

if [[ "${CONFIRM_WAL_TEST:-}" != "YES" ]]; then
  read -r -p "Type WAL-ARCHIVE to force a WAL switch and test archiving: " confirmation
  [[ "${confirmation}" == "WAL-ARCHIVE" ]] || { echo "Cancelled."; exit 2; }
fi

exec ansible-playbook -i "${inventory}" \
  "${repo_root}/tests/playbooks/wal_archive.yml" \
  -e confirm_wal_archive_test=true "$@"
