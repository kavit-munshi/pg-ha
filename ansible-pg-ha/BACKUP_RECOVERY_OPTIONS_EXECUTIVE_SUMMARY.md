# PostgreSQL HA Backup and Recovery Options — Executive Summary

## Purpose

This paper compares three backup and recovery operating models for the
PostgreSQL 18 high-availability platform managed by `pg_auto_failover`. It is
intentionally neutral: no option should be selected until the vendor and
technical validation gates have been completed and recovery performance has
been measured in an isolated restore test.

## Current platform baseline

The platform already provides high availability through synchronous streaming
replication and `pg_auto_failover`. It also archives completed WAL segments to
the monitor node and forces a WAL switch at least every 60 minutes on the
current primary. These controls support failover and create part of a recovery
chain, but they do not constitute a complete disaster-recovery backup.

A recoverable PostgreSQL point-in-time backup requires both:

1. a compatible physical base backup; and
2. an unbroken sequence of required WAL and timeline-history files from that
   base backup to the selected recovery point.

The existing monitor archive is not off-site or immutable, and the retained
base-backup design remains disabled pending storage, credentials, automation,
monitoring, retention approval, and an isolated restore test.

## Options under consideration

### Option 1 — Rubrik-managed PostgreSQL protection with native `pg_auto_failover` integration

Rubrik would own database and WAL protection through SLA policy, follow the
active PostgreSQL role after failover, and provide product-led recovery. This
option has the potential to minimize custom automation and consolidate backup
governance, reporting, retention, immutability, and recovery operations.

The option is conditional. The current public Rubrik compatibility page found
during this review lists Community PostgreSQL through version 17, while this
platform uses PostgreSQL 18. Rubrik must provide written confirmation of the
exact product/CDM/RBS release that supports PostgreSQL 18 and
`pg_auto_failover`, including how protection follows primary changes, how both
data nodes are represented, how the monitor is protected, and how a restored
cluster is safely returned to `pg_auto_failover` control.

### Option 2 — Rubrik protects PostgreSQL without native `pg_auto_failover` awareness; monitor protected separately

Rubrik would protect the PostgreSQL data layer using its standard cluster
workflow, while the backup and DBA teams explicitly manage failover awareness.
The monitor VM/database would be protected under a separate VM or
application-consistent policy.

This option gains centralized retention, off-host protection, and Rubrik
recovery capabilities without waiting for native HA-manager integration. Its
main risk is orchestration: after a role change, the protected source and
recovery workflow must still identify the authoritative writable node. A
restored data node cannot simply return as a former primary, and restoring the
monitor separately must not reintroduce stale control-plane state. Runbooks,
fencing, source discovery, and post-restore re-registration therefore remain
joint Rubrik/DBA responsibilities.

### Option 3 — Ansible-managed WAL archiving with manually operated physical base backups

The existing Ansible WAL process would remain the continuous archive layer. A
scheduled or operator-initiated `pg_basebackup` process would dynamically
discover exactly one writable primary, create a physical base backup on a
dedicated filesystem, verify it using `pg_verifybackup`, and publish it only
after validation. Completed base backups and the required WAL chain would
still need an independent, protected, preferably immutable off-host copy.

This option gives the organization maximum transparency and control and can be
implemented without waiting for product-specific HA integration. It also
places the greatest burden on internal teams: script maintenance, backup
catalog integrity, WAL/base-backup retention coupling, capacity management,
credential handling, alerting, recovery orchestration, and audit evidence all
remain locally owned. Manual does not mean unverified—quarterly isolated
restore testing is mandatory.

## Neutral comparison

| Decision dimension | Option 1: Rubrik + native HA integration | Option 2: Rubrik without native HA integration | Option 3: Ansible WAL + manual base backup |
|---|---|---|---|
| Product dependency | Highest | High | Lowest |
| Custom automation | Lowest potential | Moderate | Highest |
| Failover awareness | Product-managed if validated | Joint Rubrik/DBA orchestration | Custom primary discovery |
| Off-host immutability | Native Rubrik capability, subject to policy | Native Rubrik capability, subject to policy | Separate repository or Rubrik copy required |
| Monitor protection | Must be confirmed in the integrated design | Separate policy and recovery runbook | Separate VM/configuration backup and rebuild runbook |
| Recovery ownership | Rubrik-led with DBA validation | Shared backup/DBA ownership | DBA/automation-led |
| Operational complexity | Lowest potential after validation | Moderate to high | Highest |
| Audit/reporting | Centralized | Centralized, with manual HA evidence | Custom evidence and monitoring |
| Main uncertainty | Release, PostgreSQL 18, and `pg_auto_failover` support | Correct source selection and safe reintegration | Long-term supportability and human error |

The descriptions above are architectural tendencies, not measured service
levels. No RPO or RTO should be committed until backup frequency, WAL cadence,
data volume, network throughput, recovery workflow, and application validation
have been tested.

## Non-negotiable controls for every option

Every acceptable solution must demonstrate:

- explicit PostgreSQL 18 and Ubuntu 24.04 support;
- a physical base backup plus the complete required WAL/timeline chain;
- safe discovery of exactly one authoritative writable primary;
- off-host, encrypted, access-controlled, immutable or equivalently protected
  retention;
- separate and safe recovery of the `pg_auto_failover` monitor;
- fencing of old primaries and stale monitors before restored systems join the
  production network;
- documented recovery to recent state and to an approved point in time;
- monitoring for missed backups, WAL failures, capacity, and overdue restore
  tests;
- a named owner and escalation path for backup, database, VMware, and
  application validation tasks;
- a successful isolated restore with measured RPO and RTO.

## Proposed evaluation and proof plan

1. Obtain a written Rubrik support statement covering PostgreSQL 18,
   Ubuntu 24.04, the exact Rubrik release, `pg_auto_failover`, backup source
   selection after promotion, monitor protection, and supported restore paths.
2. Build an evaluation matrix using the same SLA, retention, encryption,
   immutability, and evidence requirements for all three options.
3. In UAT, take a full base backup and continuous WAL backup under each viable
   option.
4. Perform a controlled `pg_auto_failover` switchover, then prove that the next
   backup follows the new primary without gaps or duplicate-authority risk.
5. Restore to an isolated PostgreSQL 18 host, validate the backup manifest or
   product integrity checks, and replay to both a recent state and a named
   restore point.
6. Test monitor loss and replacement separately; confirm that no stale monitor
   or former primary can rejoin unfenced.
7. Measure backup duration, workload impact, achieved RPO, technical restore
   time, application-validation time, operational effort, and evidence quality.
8. Select an option only after the proof results, residual risks, ownership,
   commercial terms, and support commitments are accepted.

## Decision required

The immediate decision is not which option to deploy. It is whether to fund and
schedule a common proof-of-recovery exercise and require Rubrik to close the
PostgreSQL 18/`pg_auto_failover` support questions. The final architecture
decision should follow that evidence.

## Sources

- Repository: `DB_BACKUP_AND_RECOVERY_RUNBOOK.md`
- Repository: `SYSTEM_ARCHITECTURE_AND_RECOVERY.md`
- [Rubrik PostgreSQL protection compatibility](https://docs.rubrik.com/en-us/compat_matrix/compat_matrix/cm_postgresql_protection.html)
- [Rubrik PostgreSQL protection overview](https://docs.rubrik.com/en-us/saas/postgresql/postgresql.html)
- [Rubrik PostgreSQL protection prerequisites](https://docs.rubrik.com/en-us/saas/postgresql/postgresql_protection_prereq.html)
- [Rubrik PostgreSQL limitations](https://docs.rubrik.com/en-us/saas/postgresql/postgresql_limitations.html)
- [Rubrik Developer Center — PostgreSQL](https://developer.rubrik.com/Rubrik-Security-Cloud-API/Data-Protection/Data-Center/PostgreSQL/)
- [PostgreSQL 18 continuous archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)
- [PostgreSQL 18 `pg_basebackup`](https://www.postgresql.org/docs/18/app-pgbasebackup.html)
