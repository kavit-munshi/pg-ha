#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
inventory="${INVENTORY:-${repo_root}/inventories/uat_hosts.ini}"

if [[ "${CONFIRM_ROUTING_FAILOVER:-}" != "YES" ]]; then
  read -r -p "Type ROUTING-FAILOVER to interrupt the active VIP router: " confirmation
  [[ "${confirmation}" == "ROUTING-FAILOVER" ]] || { echo "Cancelled."; exit 2; }
fi

exec ansible-playbook -i "${inventory}" \
  "${repo_root}/tests/playbooks/routing_failover.yml" \
  -e confirm_routing_failover=true "$@"
