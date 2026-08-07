# PostgreSQL 18 HA deployment

This repository deploys a five-node PostgreSQL 18 platform on Ubuntu 24.04:

- pg_auto_failover monitor, initial primary, and synchronous standby
- two PgBouncer nodes behind a Keepalived VIP and HAProxy
- XFS/LVM storage matching the per-role disk layout
- node, PostgreSQL, and PgBouncer Prometheus exporters
- SSH-based WAL shipping to the monitor/archive node
- optional Logstash forwarding and Rubrik RBS hook

Documentation:

- [DEPLOYMENT_HOWTO.md](DEPLOYMENT_HOWTO.md) — copy-paste UAT and Production
  deployment and verification guide
- [CODEBASE_ARCHITECTURE.md](CODEBASE_ARCHITECTURE.md) — engineering reference
  for repository structure, roles, variables, and execution logic
- [OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md) — original concise operator
  runbook
- [UAT_ENVIRONMENT_HANDOVER.md](UAT_ENVIRONMENT_HANDOVER.md) — complete client
  handover covering the deployed platform, access, operations, controls,
  acceptance evidence, responsibilities, and open items
- [PROD_DEPLOYMENT_PLAN.md](PROD_DEPLOYMENT_PLAN.md) — Production topology,
  required preflight decisions, deployment sequence, validation, and go/no-go
  checklist
- [tests/README.md](tests/README.md) — comprehensive health, WAL archive,
  routing failover, and PostgreSQL switchover test procedures

Environment-specific addresses are in `group_vars/uat.yml` and
`group_vars/prod.yml`; common tunables and guarded secret defaults are in
`group_vars/all.yml`.

The write path is:

```text
application -> VIP:5432 -> HAProxy -> active-primary-paired PgBouncer:6432
            -> PostgreSQL primary:5432
```

Each PgBouncer is deliberately paired with one database candidate. HAProxy
checks that candidate with `SELECT pg_is_in_recovery()` and disables its paired
pooler unless the result is `false`. This retains PgBouncer in the backend pool
while following pg_auto_failover promotions.
