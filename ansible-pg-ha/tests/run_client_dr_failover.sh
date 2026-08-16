#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${INVENTORY:-}" ]]; then
  echo "INVENTORY is required; no environment default is allowed for this exercise." >&2
  echo "Example: export INVENTORY=\"${repo_root}/inventories/uat_hosts.ini\"" >&2
  exit 2
fi

if [[ ! -f "${INVENTORY}" ]]; then
  echo "Inventory does not exist: ${INVENTORY}" >&2
  exit 2
fi

case "$(basename "${INVENTORY}")" in
  uat_hosts.ini)
    environment="UAT"
    ;;
  prod_hosts.ini)
    environment="PROD"
    ;;
  *)
    echo "Inventory must be uat_hosts.ini or prod_hosts.ini: ${INVENTORY}" >&2
    exit 2
    ;;
esac

confirmation_phrase="${environment}-CLIENT-DR-FAILOVER"

if [[ "${CONFIRM_CLIENT_DR_FAILOVER:-}" != "YES" ]]; then
  echo "This exercise performs WAL activity, interrupts the active VIP router," >&2
  echo "and performs two controlled PostgreSQL switchovers." >&2
  read -r -p "Type ${confirmation_phrase} to continue: " confirmation
  if [[ "${confirmation}" != "${confirmation_phrase}" ]]; then
    echo "Cancelled."
    exit 2
  fi
else
  confirmation="${confirmation_phrase}"
fi

test_id="${CLIENT_DR_TEST_ID:-${environment,,}-client-dr-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ ! "${test_id}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "CLIENT_DR_TEST_ID may contain only letters, numbers, dot, underscore, and dash." >&2
  exit 2
fi

evidence_dir="${repo_root}/artifacts/client-dr"
mkdir -p "${evidence_dir}"
evidence_log="${evidence_dir}/${test_id}.log"

{
  echo "Exercise ID: ${test_id}"
  echo "Environment: ${environment}"
  echo "Inventory: ${INVENTORY}"
  echo "UTC start: $(date -u --iso-8601=seconds)"
  echo "Git revision: $(git -C "${repo_root}" rev-parse HEAD)"
  echo "Operator: ${USER:-unknown}"
} | tee "${evidence_log}"

ansible-inventory -i "${INVENTORY}" --graph | tee -a "${evidence_log}"

set +e
ansible-playbook \
  -i "${INVENTORY}" \
  "${repo_root}/tests/playbooks/client_dr_failover.yml" \
  -e "client_dr_confirmation=${confirmation}" \
  -e "client_dr_test_id=${test_id}" \
  "$@" 2>&1 | tee -a "${evidence_log}"

result=${PIPESTATUS[0]}
set -e
{
  echo "UTC end: $(date -u --iso-8601=seconds)"
  echo "Ansible exit status: ${result}"
  echo "Evidence log: ${evidence_log}"
} | tee -a "${evidence_log}"

exit "${result}"
