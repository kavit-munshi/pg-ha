# PostgreSQL 18 HA deployment

This repository deploys a five-node PostgreSQL 18 platform on Ubuntu 24.04:

- pg_auto_failover monitor, initial primary, and synchronous standby
- two PgBouncer nodes behind a Keepalived VIP and HAProxy
- XFS/LVM storage matching the per-role disk layout
- node, PostgreSQL, and PgBouncer Prometheus exporters
- Rubrik-owned database and WAL protection in UAT and Production
- an optional, default-off legacy SSH WAL archive provider for rollback
- optional Logstash forwarding

Documentation:

- [DEPLOYMENT_HOWTO.md](DEPLOYMENT_HOWTO.md) — copy-paste UAT and Production
  deployment and verification guide
- [CODEBASE_ARCHITECTURE.md](CODEBASE_ARCHITECTURE.md) — engineering reference
  for repository structure, roles, variables, and execution logic
- [OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md) — original concise operator
  runbook
- [SYSTEM_ARCHITECTURE_AND_RECOVERY.md](SYSTEM_ARCHITECTURE_AND_RECOVERY.md) —
  authoritative end-to-end architecture, failure behavior, and node recovery
  procedures
- [DB_BACKUP_AND_RECOVERY_RUNBOOK.md](DB_BACKUP_AND_RECOVERY_RUNBOOK.md) —
  detailed WAL/base-backup process, data-node recovery, monitor recovery,
  VM restore, PITR, and total database-tier recovery
- [CLIENT_DR_FAILOVER_TEST_RUNBOOK.md](CLIENT_DR_FAILOVER_TEST_RUNBOOK.md) —
  client-observed automated and manual WAL, routing, database failover,
  restoration, evidence, and isolated-restore test procedures
- [UAT_ENVIRONMENT_HANDOVER.md](UAT_ENVIRONMENT_HANDOVER.md) — complete client
  handover covering the deployed platform, access, operations, controls,
  acceptance evidence, responsibilities, and open items
- [PROD_DEPLOYMENT_PLAN.md](PROD_DEPLOYMENT_PLAN.md) — Production topology,
  required preflight decisions, deployment sequence, validation, and go/no-go
  checklist
- [tests/README.md](tests/README.md) — comprehensive provider-aware health,
  routing failover, PostgreSQL switchover, and legacy rollback-WAL tests
- [RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md](RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md)
  — authoritative Rubrik cutover, legacy monitor-WAL removal, rollback, and
  database DR procedures
- [MANUAL_DB_CRASH_RECOVERY.md](MANUAL_DB_CRASH_RECOVERY.md) — manual primary
  VM crash response, fencing, routing verification, pg_rewind/rejoin diagnosis,
  and stalled recovery remediation

Environment-specific addresses are in `group_vars/uat.yml` and
`group_vars/prod.yml`; common tunables and guarded secret defaults are in
`group_vars/all.yml`.

The write path is:

```text
application -> VIP:5432 -> HAProxy -> local PgBouncer:6432
            -> local HAProxy primary selector:6433 -> PostgreSQL primary:5432
```

Both routing nodes use the same dynamic topology. PgBouncer never targets the
VIP or a fixed database node; it targets a loopback-only HAProxy listener that
checks both data candidates with `SELECT pg_is_in_recovery()` and enables only
the writable primary. This avoids a routing loop and lets either pooler follow
every pg_auto_failover promotion without a configuration rewrite.
