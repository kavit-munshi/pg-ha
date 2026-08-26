# PostgreSQL HA system test suite

Run these tests from the Ansible control server after `site.yml` completes.
They use the repository inventory and variables, including vaulted passwords.
Each test play explicitly loads `group_vars/all.yml` plus `uat.yml` or
`prod.yml` based on inventory group membership. This is required because the
playbooks live below `tests/playbooks`; without it Ansible would default SSH to
the control-node username instead of the configured `ansible` account.

## Prerequisites

- Run from the repository root or use the wrapper scripts from any directory.
- Install collections with `ansible-galaxy collection install -r requirements.yml`.
- Ensure SSH key authentication and passwordless sudo work on all five nodes.
- Supply `--ask-vault-pass`, or export `ANSIBLE_VAULT_PASSWORD_FILE` with the
  path to a protected Vault password file.
- Run disruptive tests only in an approved maintenance window with application
  owners notified.

Select an inventory by exporting `INVENTORY`; UAT is the default:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
```

Validate the suite before first use:

```bash
ansible-playbook -i "$INVENTORY" --syntax-check tests/playbooks/health.yml
ansible-playbook -i "$INVENTORY" --syntax-check tests/playbooks/wal_archive.yml
ansible-playbook -i "$INVENTORY" --syntax-check tests/playbooks/routing_failover.yml
ansible-playbook -i "$INVENTORY" --syntax-check tests/playbooks/db_failover.yml
ansible-playbook -i "$INVENTORY" --syntax-check tests/playbooks/client_dr_failover.yml
ansible-lint --project-dir . tests
```

## Read-only comprehensive health test

```bash
bash tests/run_health.sh --ask-vault-pass
```

This validates SSH/facts, Chrony, UFW, `/etc/hosts` resolution, node exporter,
database services, PostgreSQL readiness and recovery roles, XFS mounts,
provider-specific WAL settings, absence of active legacy monitor-WAL artifacts
for Rubrik, postgres exporter, pg_auto_failover state, Keepalived parsing,
exact VIP ownership, both loopback routing listeners, PgBouncer, HAProxy stats,
PgBouncer exporter, and SQL through both the local pooler path and the complete
VIP → HAProxy → local PgBouncer → HAProxy primary selector → current primary
path.

## Legacy monitor WAL archive integration test

This test is disabled for the UAT and Production Rubrik design. Use it only
when `postgresql_wal_archive_provider=monitor_ssh`, including an approved
rollback exercise:

```bash
bash tests/run_wal_archive_test.sh --ask-vault-pass
```

This requires typing `WAL-ARCHIVE`, calls `pg_switch_wal()` on the current
primary, and waits up to 180 seconds for the segment under
`/pgdata/WalArchive` on the monitor.

Rubrik backup completion, WAL/log recovery points and isolated restore/PITR
must be validated in Rubrik and attached to the test evidence. Ansible health
checks validate PostgreSQL has an active non-legacy archive command but do not
claim that a Rubrik backup job succeeded.

## Routing failover test

```bash
bash tests/run_routing_failover.sh --ask-vault-pass
```

This requires typing `ROUTING-FAILOVER`. It finds the current VIP owner, stops
Keepalived only on that router, waits for the peer to acquire the VIP, runs SQL
through the moved VIP, and always restarts Keepalived on the original router.
It then waits for the preferred router to reclaim the VIP.

## Database failover test

```bash
bash tests/run_db_failover.sh --ask-vault-pass
```

This requires typing `DB-FAILOVER`. It requires stable `primary/primary` and
`secondary/secondary` states, performs a monitor-orchestrated controlled
switchover, proves the VIP reaches the promoted node, and performs a second
switchover in the `always` recovery section to restore the original topology.
The command follows pg_auto_failover's supported `perform switchover` workflow.

## Full suite

Read-only tests only:

```bash
bash tests/run_all.sh --ask-vault-pass
```

Include routing and database disruptive tests without interactive
confirmations:

```bash
RUN_DISRUPTIVE=true bash tests/run_all.sh --ask-vault-pass
```

The legacy WAL test is not included unless both `RUN_DISRUPTIVE=true` and
`RUN_LEGACY_WAL_TEST=true` are set. Do not set the latter in Rubrik-managed UAT
or Production.

For unattended execution, prefer a protected Vault password file so each
subtest does not prompt independently:

```bash
export ANSIBLE_VAULT_PASSWORD_FILE=/secure/path/pg-ha-vault-password
RUN_DISRUPTIVE=true bash tests/run_all.sh
```

## Client-observed DR readiness and failover exercise

The client exercise requires an explicit inventory and runs baseline health,
routing failover/restoration, controlled database switchover/switchback, and
final health in one Ansible process:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
export CLIENT_DR_TEST_ID="CHG123456-client-witnessed"
bash tests/run_client_dr_failover.sh --ask-vault-pass
```

It requires typing `UAT-CLIENT-DR-FAILOVER` or
`PROD-CLIENT-DR-FAILOVER` and writes a timestamped evidence log below
`artifacts/client-dr/`. See `CLIENT_DR_FAILOVER_TEST_RUNBOOK.md` for manual
commands, hold points, stop criteria, and the separate isolated backup/PITR DR
test.

The client acceptance record must separately include Rubrik base-backup,
WAL/log recovery-point and isolated restore/PITR evidence. See
`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.

## Safety behavior

- Disruptive wrappers require typed confirmation unless the corresponding
  `CONFIRM_*` environment variable is exactly `YES`.
- The routing test uses an Ansible `always` section to restart Keepalived.
- The database test uses an `always` section to return the original node to
  primary whenever the cluster reaches a stable state.
- The suite never deletes data, drops a node, edits monitor state, or uses
  `--allow-data-loss`.
- If automatic restoration cannot reach a stable state, stop application
  writes and follow the pg_auto_failover recovery runbook before rerunning.
