#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
inventory="${INVENTORY:-${repo_root}/inventories/uat_hosts.ini}"

exec ansible-playbook -i "${inventory}" \
  "${repo_root}/tests/playbooks/health.yml" "$@"
