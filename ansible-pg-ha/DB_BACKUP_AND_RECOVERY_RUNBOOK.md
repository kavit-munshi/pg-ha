# PostgreSQL 18 Backup and Database Recovery Runbook

## 1. Supported backup design

Rubrik is the sole database and archived-WAL backup provider for UAT and
Production. The former SSH/rsync archive to the pg_auto_failover monitor is a
default-off rollback provider and must not run concurrently with Rubrik.

PostgreSQL continues to generate WAL with `wal_level=replica` for streaming
replication. Rubrik owns the effective `archive_mode`, `archive_command`,
backup catalog, retention and PITR media.

The detailed UAT/Production cutover, validation, rollback and scenario recovery
procedures are maintained in
[`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`](RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md).

## 2. Environment reference

| Environment | Data candidate 1 | Data candidate 2 | Monitor | VIP |
|---|---|---|---|---|
| UAT | `BHC-QMSSQLU05` | `BHC-QMSSQLU06` | `BHC-QMSSQLU07` | `192.168.129.110` |
| Production | `BHC-QMSSQLP01.bayshore.ca` | `BHC-QMSSQLP02.bayshore.ca` | `BHC-QMSSQLP03.bayshore.ca` | `PGBQMSLSP01` / `192.168.128.139` |

Roles must always be discovered from `pg_autoctl show state`; inventory group
names describe initial placement and are not proof of the current primary.

## 3. Required operational controls

- Daily Rubrik base/database backups under the approved SLA.
- Rubrik WAL/log recovery points at the approved RPO.
- Rubrik agent/configuration ready on either data candidate after promotion.
- Separate protection or rebuild procedure for the monitor VM.
- Backup alerts routed to the operations team.
- Quarterly isolated restore/PITR testing, or the client-approved frequency.
- Recorded backup ID, recovery point, measured RPO/RTO and validation evidence.
- No deletion of legacy `/pgdata/WalArchive` content until a separate retention
  change is approved.

## 4. Daily verification

From the Ansible control server:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
# Production: export INVENTORY="$PWD/inventories/prod_hosts.ini"

ansible db_monitor -i "$INVENTORY" -b --become-user postgres \
  -m command -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"

bash tests/run_health.sh --ask-vault-pass
```

The backup operator must separately confirm in Rubrik:

1. latest successful base/database backup;
2. latest WAL/log recovery point;
3. SLA compliance and retention;
4. no failed or stalled jobs;
5. protection remains attached to the writable node after a promotion.

Ansible verifies effective PostgreSQL archive ownership and absence of active
legacy monitor-WAL artifacts. It does not claim that a Rubrik job completed.

## 5. Recovery decision table

| Failure | Immediate response | Recovery source |
|---|---|---|
| Standby lost | Keep primary online; rebuild standby with empty PGDATA | Clone from current primary through pg_auto_failover |
| Primary lost, standby healthy | Allow monitored promotion; fence old primary | Streaming replica, then rejoin old node |
| One VM restored from VM backup | Fence it; do not start as an independent primary | Rebuild/rejoin from current primary |
| Both data nodes lost | Fence both; block VIP; restore one authoritative copy | Rubrik base backup plus WAL/PITR |
| Monitor lost | Avoid role changes; restore/rebuild monitor | Monitor VM protection or clean monitor rebuild |
| Site loss | Isolate DR network; restore one database first | Rubrik DR copy and approved recovery point |

## 6. Core recovery rules

1. Fence any node that might still be writable.
2. Confirm exactly one source of truth before starting PostgreSQL.
3. Never independently restore and start both data nodes.
4. Restore one database and validate it in isolation.
5. Never allow a stale monitor to control restored data nodes.
6. Register the recovered database as the first primary under a trusted
   monitor.
7. Seed the new secondary from that primary with empty PGDATA.
8. Validate pg_auto_failover, replication, Rubrik and VIP routing before
   application access.

## 7. Failed standby recovery

1. Confirm the primary is writable, healthy and protected by Rubrik.
2. Fence the failed standby.
3. Repair or replace the VM and validate its LVM/XFS mounts.
4. Keep `/pgdata/pgroot/data` empty; do not place an independent Rubrik restore
   there.
5. Apply the Ansible prerequisites and pg_auto_failover role.
6. Register/rejoin it with the existing monitor.
7. Allow pg_auto_failover to clone from the current primary.
8. Require stable `secondary/secondary`, acceptable lag and Rubrik readiness
   for future promotion.

## 8. Failed primary recovery

1. Confirm the monitor promoted the healthy standby.
2. Confirm HAProxy/VIP reaches that writable node.
3. Confirm Rubrik WAL/log protection continued after promotion.
4. Fence the failed former primary before it boots or reconnects.
5. Repair/rebuild it and rejoin it as a secondary from the current primary.
6. Do not restore the former primary from an older VM or database backup and
   start it alongside the promoted database.
7. Record a new Rubrik recovery point after HA stabilizes.

## 9. Complete database-tier recovery

1. Declare the incident and select the authorized Rubrik recovery point.
2. Fence both original data VMs and disable application access through the VIP.
3. Restore one data node using the vendor-supported PostgreSQL workflow.
4. Validate filesystem paths, ownership, PostgreSQL version and restored data.
5. Start and validate the database in isolation.
6. Restore or cleanly rebuild the monitor; reject stale formation state.
7. Register the restored database as the initial primary.
8. Build the second data node with empty PGDATA and clone from the primary.
9. Validate one writable node, one secondary, replication and exporters.
10. Confirm Rubrik protects the recovered cluster and produces a new recovery
    point.
11. Re-enable routing and obtain application-owner acceptance.

## 10. Monitor recovery

The database may continue serving traffic while the monitor is unavailable,
but automated failover is not available. Confirm the current writable node,
avoid unnecessary restarts/promotions, restore or rebuild the monitor, validate
formation membership and system identifiers, reconnect data nodes as required,
and wait for stable states. A monitor backup is control-plane protection; it is
not a substitute for Rubrik database/PITR protection.

## 11. Restore/PITR acceptance

An isolated restore is successful only when:

- the requested recovery point is reachable;
- PostgreSQL starts without unexpected recovery errors;
- critical schemas, row counts and application transactions validate;
- measured RPO and RTO meet the approved objectives;
- no connection exists to the Production VIP during validation;
- the procedure for registering the recovered primary and cloning a standby is
  demonstrated;
- evidence is retained with the change/test record.

## 12. Legacy monitor archive rollback

The legacy provider is emergency rollback only. Its SSH keys and monitor
authorization are intentionally retained, but no key deletion/recreation is
part of normal cleanup. Before rollback, pause Rubrik WAL ownership. Select
`postgresql_wal_archive_provider=monitor_ssh`, apply `backup_wal` one data node
at a time, and run the legacy WAL test only after HA is stable. The complete
commands and stop conditions are in
`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.

## 13. Forced legacy removal

`wal_archive_cleanup_force=true` may be used under an approved break-glass
change to remove active monitor-WAL settings without confirming Rubrik
readiness. It preserves every SSH key and archive file, bypasses provider
validation, and may create a backup/PITR gap. Standard health tests continue to
report the missing Rubrik provider state. Use the detailed procedure and
capacity monitoring in `RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.
