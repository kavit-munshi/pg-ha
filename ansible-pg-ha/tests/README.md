# PostgreSQL HA system test suite

Run these tests from the Ansible control server after `site.yml` completes.
They use the repository inventory and variables, including vaulted passwords.

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
ansible-lint tests
```

## Read-only comprehensive health test

```bash
bash tests/run_health.sh --ask-vault-pass
```

This validates SSH/facts, Chrony, UFW, `/etc/hosts` resolution, node exporter,
database services, PostgreSQL readiness and recovery roles, XFS mounts, WAL
settings, postgres exporter, pg_auto_failover state, Keepalived parsing, exact
VIP ownership, PgBouncer, HAProxy stats, PgBouncer exporter, and a SQL query
through VIP → HAProxy → PgBouncer → current primary.

## WAL archive integration test

```bash
bash tests/run_wal_archive_test.sh --ask-vault-pass
```

This requires typing `WAL-ARCHIVE`, calls `pg_switch_wal()` on the current
primary, and waits up to 180 seconds for the segment under
`/pgdata/WalArchive` on the monitor.

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

Include all disruptive tests without interactive confirmations:

```bash
RUN_DISRUPTIVE=true bash tests/run_all.sh --ask-vault-pass
```

For unattended execution, prefer a protected Vault password file so each
subtest does not prompt independently:

```bash
export ANSIBLE_VAULT_PASSWORD_FILE=/secure/path/pg-ha-vault-password
RUN_DISRUPTIVE=true bash tests/run_all.sh
```

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
