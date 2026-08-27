# Rubrik WAL Cutover and Database Recovery Runbook

## 1. Purpose and final design

This runbook moves UAT and Production from the legacy Ansible-managed SSH WAL
archive on the pg_auto_failover monitor to Rubrik-managed database and WAL
protection. Rubrik is the only supported backup owner for these environments.

This change does not disable PostgreSQL WAL. `wal_level=replica` remains
required for streaming replication and pg_auto_failover. It removes only the
legacy `archive_command` that copied completed WAL files to
`/pgdata/WalArchive` on the monitor.

| Component | Owner after cutover |
|---|---|
| WAL generation and streaming replication | PostgreSQL and pg_auto_failover |
| Base/database backups, archived WAL, retention and PITR media | Rubrik |
| Primary/standby promotion and rejoin | pg_auto_failover |
| Backup prerequisites and legacy cleanup | Ansible |
| HA reconstruction after a restore | Operator, Ansible and pg_auto_failover |

## 2. Safety commitments

The Ansible cleanup does not delete or change:

- `/var/lib/postgresql/.ssh/id_ed25519_wal_archive` or its public key;
- monitor `authorized_keys` entries;
- the `postgres-wal-ssh` group or SSH policy;
- `/pgdata/WalArchive`, its filesystem, fstab entry, or existing files.

These items are retained for controlled rollback. Their eventual retirement
requires a separate security and data-retention change.

## 3. Provider selection

`postgresql_wal_archive_provider` supports:

| Value | Behaviour |
|---|---|
| `rubrik` | Rubrik must supply `archive_mode=on` and a non-legacy archive command. Ansible removes the monitor integration and verifies Rubrik ownership. |
| `monitor_ssh` | Ansible installs and validates the legacy SSH/rsync archive and forced-switch timer. |
| `none` | Ansible removes the monitor archive and requires `archive_mode=off`. Streaming replication remains enabled. |

UAT and Production select `rubrik`; new environments default to `none` and
must opt in deliberately. `rubrik_archive_command_validation_pattern` may be
set to an approved regular expression when the exact Rubrik command is known.
`rubrik_wal_cutover_confirmed` defaults to false and blocks cleanup until the
operator explicitly confirms Rubrik readiness.

### 3.1 Emergency forced cleanup

`wal_archive_cleanup_force` defaults to false. Setting it true allows the
legacy monitor integration to be removed without a confirmed Rubrik base
backup and without requiring an active Rubrik `archive_command` or
`archive_library` after cleanup.

This is an emergency break-glass option, not a successful Rubrik cutover. It:

- removes the same active legacy files and timer;
- preserves all WAL SSH keys, monitor authorization, archive storage and files;
- bypasses `rubrik_wal_cutover_confirmed`;
- bypasses the Rubrik and `none` post-cleanup provider assertions;
- prints the effective PostgreSQL archive state without declaring it healthy;
- does not suppress provider-aware health-test failures afterward.

Use it only when management has explicitly accepted a temporary backup/PITR
gap. If `archive_mode=on` remains paired with an empty or failing command,
monitor `/pgdata/wal` continuously because completed WAL may accumulate.

## 4. Components removed by Ansible

On both data nodes cleanup removes:

```text
/usr/local/sbin/archive-wal
/usr/local/sbin/force-wal-archive
/usr/local/sbin/rubrik-rbs-wal-hook
/etc/systemd/system/postgresql-wal-archive-hourly.service
/etc/systemd/system/postgresql-wal-archive-hourly.timer
/pgdata/pgroot/data/postgresql-archive.conf
```

It removes the `postgresql-archive.conf` include from
`postgresql-ha.conf`, reloads systemd, restarts `pg_autoctl` only when the
PostgreSQL configuration changed, waits for PostgreSQL, and validates the
effective provider. Database/user provisioning is now independent in the
`database_bootstrap` role, so disabling the legacy archive does not omit the
application, HAProxy-health, or exporter accounts.

## 5. Required Rubrik acceptance evidence

Before cleanup, obtain written confirmation of:

1. the deployed Rubrik/CDM/RBS release;
2. PostgreSQL 18 and Ubuntu 24.04 support;
3. the supported pg_auto_failover promotion workflow;
4. whether RBS is installed on both data-node candidates;
5. the durable configuration that owns `archive_mode` and `archive_command`
   after either node is promoted;
6. base-backup schedule, WAL/log frequency, retention and encryption;
7. required firewall source addresses, directions and ports;
8. how to verify the latest successful backup and recovery point;
9. the vendor-supported restore procedure.

Before applying the Ansible firewall role, populate the selected environment's
`rubrik_allowed_cidrs` with the approved Rubrik cluster/source addresses. On
the two data nodes only, the role permits inbound TCP 12800/12801 from Rubrik
and outbound TCP 111/9639/32764:32769 plus UDP 111/32764:32769 to Rubrik. It
rejects empty endpoint lists, `any`, and `::/0`. An IPv4 `0.0.0.0/0` exception
requires `rubrik_allow_world_source=true`, must be recorded as a temporary
break-glass exposure, and should be replaced with Rubrik node `/32` entries.
The network team must permit the same directional flows on external firewalls
and confirm them against the installed Rubrik release.

Rubrik configuration must be durable before the legacy include is removed.
Never leave `archive_mode=on` with an empty or failing `archive_command`; WAL
can accumulate until `/pgdata/wal` fills. Never use `/bin/true` as a temporary
archive command because it breaks the PITR chain.

## 6. Common pre-change commands

Run from the Ansible control server and select exactly one inventory:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
# Production instead:
# export INVENTORY="$PWD/inventories/prod_hosts.ini"
```

Confirm inventory and connectivity:

```bash
ansible-inventory -i "$INVENTORY" --graph
ansible all_nodes -i "$INVENTORY" -m ping
```

Record pg_auto_failover state:

```bash
ansible db_monitor -i "$INVENTORY" -b --become-user postgres \
  -m command -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

Record effective archive settings:

```bash
ansible 'db_primary:db_standby' -i "$INVENTORY" \
  -b --become-user postgres -m shell -a \
  "psql -XAtd postgres -c \"SELECT name || '=' || setting FROM pg_settings WHERE name IN ('wal_level','archive_mode','archive_command','archive_timeout') ORDER BY name\""
```

Record archiver counters and WAL capacity:

```bash
ansible 'db_primary:db_standby' -i "$INVENTORY" \
  -b --become-user postgres -m shell -a \
  "psql -X -d postgres -c 'TABLE pg_stat_archiver'; df -hT /pgdata/wal"
```

Record legacy timer and files:

```bash
ansible 'db_primary:db_standby' -i "$INVENTORY" -b -m shell -a \
  "systemctl status postgresql-wal-archive-hourly.timer --no-pager || true; ls -l /usr/local/sbin/archive-wal /usr/local/sbin/force-wal-archive /pgdata/pgroot/data/postgresql-archive.conf 2>/dev/null || true"
```

Retain the output in the change record. Take no cleanup action until Rubrik
reports a successful base backup and is ready to own WAL/log backup.

## 7. UAT removal procedure

| Function | UAT host |
|---|---|
| Data candidate 1 | `BHC-QMSSQLU05` |
| Data candidate 2 | `BHC-QMSSQLU06` |
| Monitor | `BHC-QMSSQLU07` |

### 7.1 Prepare Rubrik

1. Install and register the approved Rubrik components.
2. Apply the UAT Rubrik SLA.
3. Confirm Rubrik's durable PostgreSQL archive configuration exists on both
   candidates and will survive promotion.
4. Complete and record a successful on-demand base backup.
5. Confirm the repository resolves the provider to `rubrik`:

```bash
ansible-inventory -i inventories/uat_hosts.ini --host BHC-QMSSQLU05 --yaml \
  --ask-vault-pass | grep -A1 postgresql_wal_archive_provider
```

### 7.2 Identify actual roles

Use `pg_autoctl show state`. Do not assume the inventory's original primary is
still primary. Record the current `secondary` and current `primary` hostnames.

### 7.3 Clean the current secondary first

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml \
  --limit '<CURRENT_SECONDARY>' \
  --tags wal_archive_cleanup \
  -e rubrik_wal_cutover_confirmed=true \
  --ask-vault-pass
```

Verify it returns to `secondary/secondary`:

```bash
ansible BHC-QMSSQLU07 -i inventories/uat_hosts.ini \
  -b --become-user postgres -m command \
  -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

### 7.4 Clean the current primary

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml \
  --limit '<CURRENT_PRIMARY>' \
  --tags wal_archive_cleanup \
  -e rubrik_wal_cutover_confirmed=true \
  --ask-vault-pass
```

If the change causes a promotion, stop and allow pg_auto_failover to reach a
stable state. Never run cleanup concurrently on both data nodes.

### 7.5 Validate UAT

```bash
bash tests/run_health.sh --ask-vault-pass
```

Confirm active legacy artifacts are gone while keys remain:

```bash
ansible 'db_primary:db_standby' -i inventories/uat_hosts.ini -b -m shell -a \
  "test ! -e /usr/local/sbin/archive-wal; test ! -e /usr/local/sbin/force-wal-archive; test ! -e /etc/systemd/system/postgresql-wal-archive-hourly.timer; test -e /var/lib/postgresql/.ssh/id_ed25519_wal_archive"
```

Require a new Rubrik WAL/log recovery point, controlled database switchover,
continued Rubrik protection after promotion, routing failover, isolated Rubrik
restore/PITR, and one complete SLA cycle. Do not run
`tests/run_wal_archive_test.sh` while the provider is Rubrik.

After formal UAT acceptance, set `rubrik_wal_cutover_confirmed: true` in
`group_vars/uat.yml` through a reviewed commit. This allows future complete
idempotent deployments without an extra variable while recording that the
safety gate was formally accepted.

## 8. Production removal procedure

| Function | Production host |
|---|---|
| Data candidate 1 | `BHC-QMSSQLP01.bayshore.ca` |
| Data candidate 2 | `BHC-QMSSQLP02.bayshore.ca` |
| Monitor | `BHC-QMSSQLP03.bayshore.ca` |

After UAT acceptance:

1. Open the approved maintenance window.
2. Identify actual primary/secondary roles from the monitor.
3. Confirm a successful Rubrik Production base backup and durable WAL
   configuration on both candidates.
4. Clean the current secondary:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --limit '<CURRENT_SECONDARY_FQDN>' \
  --tags wal_archive_cleanup \
  -e rubrik_wal_cutover_confirmed=true \
  --ask-vault-pass
```

5. Wait for stable `secondary/secondary` and acceptable replication lag.
6. Clean the current primary:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --limit '<CURRENT_PRIMARY_FQDN>' \
  --tags wal_archive_cleanup \
  -e rubrik_wal_cutover_confirmed=true \
  --ask-vault-pass
```

7. Validate Production:

```bash
INVENTORY="$PWD/inventories/prod_hosts.ini" \
  bash tests/run_health.sh --ask-vault-pass
```

8. Confirm a new Rubrik WAL/log recovery point.
9. Run an approved switchover and prove Rubrik follows the writable node.
10. Retain `/pgdata/WalArchive` and all WAL SSH keys unchanged.
11. Observe at least one complete SLA cycle before closing the change.
12. After formal Production acceptance, set
    `rubrik_wal_cutover_confirmed: true` in `group_vars/prod.yml` through a
    reviewed commit so future full deployments pass the recorded safety gate.

## 8.1 Forced removal when Rubrik is not ready

Use only under an approved emergency change. Identify the actual secondary and
primary first, then process one node at a time:

```bash
ansible-playbook -i "$INVENTORY" site.yml \
  --limit '<CURRENT_SECONDARY>' \
  --tags wal_archive_cleanup \
  -e wal_archive_cleanup_force=true \
  --ask-vault-pass

ansible-playbook -i "$INVENTORY" site.yml \
  --limit '<CURRENT_PRIMARY>' \
  --tags wal_archive_cleanup \
  -e wal_archive_cleanup_force=true \
  --ask-vault-pass
```

Immediately record the resulting settings and capacity:

```bash
ansible 'db_primary:db_standby' -i "$INVENTORY" \
  -b --become-user postgres -m shell -a \
  "psql -XAtd postgres -c \"SELECT name || '=' || setting FROM pg_settings WHERE name IN ('wal_level','archive_mode','archive_command','archive_library') ORDER BY name\"; df -hT /pgdata/wal"
```

Expected consequences:

- normal `tests/run_health.sh` can fail its Rubrik provider assertion;
- no Rubrik recovery point should be claimed until Rubrik is operational;
- application HA streaming remains available because `wal_level=replica` is
  retained;
- PITR coverage may have a gap beginning at the last verified backup/WAL point;
- the incident/change remains open until Rubrik passes or the approved
  `none`/rollback state is established.

## 9. HA and DR testing after cutover

The client Ansible exercise now tests platform HA only:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
export CLIENT_DR_TEST_ID="CHG123456-client-witnessed"
bash tests/run_client_dr_failover.sh --ask-vault-pass
```

It validates health, routing failover, database switchover, topology
restoration and final health. It does not force a segment into the retired
monitor archive and does not perform a destructive Rubrik restore.

Attach Rubrik evidence separately:

- latest successful base backup identifier and timestamp;
- latest WAL/log recovery point and calculated RPO;
- retention/SLA policy;
- restore-test identifier, target and result;
- proof that protection continued after database promotion.

## 10. Rubrik database disaster recovery

### 10.1 Recovery principles

1. Fence every potentially writable old database node.
2. Disable application access at HAProxy or the VIP for full-cluster DR.
3. Restore one authoritative database copy first.
4. Never start two independently restored copies as writable primaries.
5. Recover to the approved time using the vendor-supported Rubrik workflow.
6. Validate the restored database in isolation.
7. Re-establish a trusted pg_auto_failover monitor.
8. Register the recovered database as the first data node.
9. Seed the second node from that recovered primary.
10. Re-enable routing only after HA, Rubrik and application validation.

### 10.2 Loss of one standby

1. Confirm the primary and Rubrik protection are healthy.
2. Fence the failed standby.
3. Repair/rebuild the VM and storage.
4. Keep PGDATA empty; do not restore an independent Rubrik copy as standby.
5. Deploy prerequisites with Ansible.
6. Register it with the monitor and let pg_auto_failover clone the primary.
7. Wait for `secondary/secondary` and validate replication and Rubrik agent
   readiness for a future promotion.

### 10.3 Loss of the primary with a healthy standby

1. Confirm pg_auto_failover promotes the standby.
2. Confirm the VIP reaches the new writable primary.
3. Confirm Rubrik WAL/log protection follows the promoted node.
4. Fence the old primary before it returns.
5. Rebuild/rejoin it as secondary; do not restore it as another primary.
6. Validate a new Rubrik recovery point.

### 10.4 Loss of both data nodes

1. Fence both old VMs and block application connections.
2. Select the Rubrik snapshot/PITR target with the application owner.
3. Restore one node using the Rubrik-supported PostgreSQL workflow.
4. Validate ownership, tablespaces, WAL path and PostgreSQL 18 binaries.
5. Start it in isolation and validate application data.
6. Build or validate the monitor without allowing stale state to control it.
7. Register the recovered node as the initial primary.
8. Create the second node with empty PGDATA and let pg_auto_failover clone it.
9. Verify HA state, replication, exporters and Rubrik.
10. Re-enable HAProxy and the VIP after application acceptance.

### 10.5 Loss of the monitor

Database traffic can continue, but automated failover is unavailable. Confirm
the writable data node, avoid role changes, restore or rebuild the monitor,
verify its formation and system identifiers, reconnect/re-register data nodes
as required, and validate stable states. Monitor recovery is separate from
Rubrik database PITR; a stale monitor must not control restored data nodes.

## 11. Rollback to the retained monitor archive

Pause Rubrik WAL protection through its supported procedure first. Because
keys and authorization were retained, no SSH-key deletion or recreation is
needed. Run the legacy role one node at a time:

```bash
ansible-playbook -i "$INVENTORY" site.yml \
  --limit '<CURRENT_SECONDARY>' --tags backup_wal \
  -e postgresql_wal_archive_provider=monitor_ssh --ask-vault-pass

ansible-playbook -i "$INVENTORY" site.yml \
  --limit '<CURRENT_PRIMARY>' --tags backup_wal \
  -e postgresql_wal_archive_provider=monitor_ssh --ask-vault-pass
```

After both nodes are stable, verify one legacy archive operation:

```bash
bash tests/run_wal_archive_test.sh \
  -e postgresql_wal_archive_provider=monitor_ssh --ask-vault-pass
```

Confirm the segment reaches `/pgdata/WalArchive` and `pg_stat_archiver` reports
success. Never run Rubrik and monitor archive ownership concurrently.

## 12. Stop conditions

Stop and preserve the current stable state if no Rubrik base backup exists,
the Rubrik command is empty/failing, `/pgdata/wal` grows unexpectedly,
pg_auto_failover is unstable, two nodes report writable, Rubrik does not follow
promotion, administrative access changes, application validation fails, or a
restore test cannot meet the agreed RPO/RTO.
