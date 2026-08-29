# Manual PostgreSQL Primary Crash Recovery

## 1. Purpose and scope

This runbook covers the operator response when the current PostgreSQL primary
VM crashes or is powered off and later returns. It applies to PostgreSQL 18
managed by `pg_auto_failover` in UAT and Production.

It covers automatic promotion, routing validation, split-brain prevention,
`pg_rewind`, standby rejoin, a node stuck in `catchingup`, and the observed
condition where recovery waits at an exact WAL-segment boundary.

This is a single-node recovery procedure. If one authoritative database is
healthy, do not restore an independent copy of the failed node from Rubrik.
Rejoin or reseed it from the current primary so that only one database history
remains authoritative.

## 2. Safety rules

1. Never assume the inventory group `db_primary` identifies the current
   primary. Database roles change after failover.
2. Never run another switchover while a node is failed or the formation is in
   `wait_primary`, `demoted`, or `catchingup`.
3. Fence the old primary before it returns. It must not receive application
   traffic or start as an independent writable database.
4. Do not use `pg_ctl start`, remove `standby.signal`, or promote the returning
   node manually. Let the `pg_autoctl` supervisor control PostgreSQL.
5. Do not delete PGDATA, run `initdb`, or begin a Rubrik restore merely because
   `catchingup` takes longer than expected.
6. Do not restart a stalled recovery until its logs and replication state have
   been captured and the blocking condition is known.
7. Keep `wal_level=replica`. Do not change Rubrik archive ownership during a
   node rejoin.

## 3. Select the environment

UAT:

```bash
cd ~/code/ansible-pg-ha
export INVENTORY="$PWD/inventories/uat_hosts.ini"
export MONITOR_NODE="BHC-QMSSQLU07"
```

Production:

```bash
cd ~/code/ansible-pg-ha
export INVENTORY="$PWD/inventories/prod_hosts.ini"
export MONITOR_NODE="BHC-QMSSQLP03.bayshore.ca"
```

Confirm inventory and connectivity:

```bash
ansible-inventory -i "$INVENTORY" --graph
ansible all_nodes -i "$INVENTORY" -m ping
```

## 4. Expected automatic behavior

After a real primary crash, the monitor should mark the old primary unhealthy,
promote the standby, assign the old primary `demoted`, and make the promoted
node writable. The promoted node often remains in `wait_primary` until the
failed node rejoins as a healthy secondary.

`wait_primary` can be writable. It indicates that application service has
resumed but HA protection is degraded because no healthy standby is available.

Measure application recovery through continuous SQL queries to the VIP. Full
cluster recovery ends only at stable `primary/primary` and
`secondary/secondary`.

## 5. Identify the authoritative database

Record cluster state:

```bash
ansible db_monitor \
  -i "$INVENTORY" \
  -b --become-user postgres \
  -m command \
  -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

An example immediately after promotion is:

```text
Old node  read-write !  reported=primary       assigned=demoted
New node  read-write    reported=wait_primary  assigned=wait_primary
```

The old node's `reported=primary` can be stale. The exclamation mark means its
connection/state is unhealthy, while `assigned=demoted` is the monitor's
authoritative instruction. The `wait_primary` node is the current writable
database.

Set variables using the actual state, not inventory group names:

```bash
export FAILED_NODE="<FORMER_PRIMARY_HOSTNAME>"
export SURVIVING_NODE="<PROMOTED_PRIMARY_HOSTNAME>"
export SURVIVING_IP="<PROMOTED_PRIMARY_IP>"
```

Example when U06 has been promoted:

```bash
export FAILED_NODE="BHC-QMSSQLU05"
export SURVIVING_NODE="BHC-QMSSQLU06"
export SURVIVING_IP="192.168.129.106"
```

## 6. Verify routing and SQL

Show the database selected by both HAProxy instances:

```bash
ansible routing_nodes \
  -i "$INVENTORY" \
  -b -m shell \
  -a "echo 'show stat' | socat stdio /run/haproxy/admin.sock |
      awk -F, '\$1 == \"postgresql_primary_selector\" &&
                 \$2 != \"FRONTEND\" &&
                 \$2 != \"BACKEND\" {
                   printf \"%-30s status=%-6s check=%s\\n\", \$2, \$18, \$37
                 }'"
```

The promoted primary must be the only database backend showing
`UP/PROCOK`. The failed node normally shows `DOWN/PROCTOUT`. After it becomes a
healthy standby, it normally shows `DOWN/PROCERR` because the write selector
intentionally rejects read-only nodes.

Prove the actual destination through the VIP from an authorized client:

```bash
psql -W -h <POSTGRESQL_VIP> -p 5432 -U qms_app -d qms -XAt \
  -c "SELECT host(inet_server_addr()),
             inet_server_port(),
             pg_is_in_recovery(),
             current_timestamp;"
```

The address must be the promoted node and `pg_is_in_recovery()` must be `f`.
The UAT VIP is `192.168.129.110`.

## 7. Fence and return the failed VM

Keep the old primary powered off or otherwise fenced until promotion is
confirmed. If VMware fencing is unavailable but Ansible still reaches the
host, an emergency software fence is:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m systemd \
  -a "name=pg_autoctl state=stopped"

ansible "$FAILED_NODE" -i "$INVENTORY" -b -m shell \
  -a "ss -lntp | grep ':5432 ' || true"
```

When returning the VM, first verify SSH, storage, and free space:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -m ping

ansible "$FAILED_NODE" -i "$INVENTORY" -b -m shell \
  -a "findmnt -T /pgdata/pgroot/data;
      findmnt -T /pgdata/pgroot/data/pg_wal;
      findmnt -T /pgdata/log;
      df -hT /pgdata/pgroot/data /pgdata/pgroot/data/pg_wal /pgdata/log"
```

The WAL path must resolve to the dedicated XFS WAL logical volume. Stop if a
required mount is missing or resolves to the OS root filesystem.

Check the TLS key, which has previously been changed by backup integration:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m command \
  -a "stat -Lc '%U:%G %a %n' /pgdata/pgroot/data/server.key"
```

Required:

```text
postgres:postgres 600 /pgdata/pgroot/data/server.key
```

Correct it if necessary:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m file \
  -a "path=/pgdata/pgroot/data/server.key owner=postgres group=postgres mode=0600"
```

Do not grant the Rubrik group access to the PostgreSQL TLS private key.

Start only the supervisor:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m systemd \
  -a "name=pg_autoctl state=started enabled=true"
```

## 8. pg_rewind and normal rejoin

When timelines have diverged, pg_autoctl normally runs `pg_rewind`. Healthy
messages include:

```text
Rewinding PostgreSQL to follow new primary
pg_rewind: reading source file list
pg_rewind: reading target file list
pg_rewind: reading WAL in target
pg_rewind: Done!
Creating the standby signal file
```

It then creates `standby.signal`, writes
`postgresql-auto-failover-standby.conf`, and starts PostgreSQL in recovery.
Do not interrupt a progressing rewind or run a second rewind manually.

Monitor state:

```bash
watch -n 3 "ansible db_monitor \
  -i '$INVENTORY' \
  -b --become-user postgres \
  -m command \
  -a 'pg_autoctl show state --pgdata /pgdata/pgroot/data' \
  --one-line"
```

Expected progression:

```text
Former primary: demoted -> catchingup -> secondary
Promoted node:  wait_primary -> primary
```

## 9. Consistent recovery has not been reached

Immediately after rewind, this can be normal:

```text
FATAL: the database system is not yet accepting connections
DETAIL: Consistent recovery state has not been yet reached.
```

Allow up to five minutes for startup and WAL replay:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "for attempt in \$(seq 1 60); do
        /usr/lib/postgresql/18/bin/pg_isready -h 127.0.0.1 -p 5432 && exit 0
        sleep 5
      done
      exit 1"
```

If it remains inconsistent, stop repeated `psql` checks because their FATAL
messages obscure the actual startup log. PostgreSQL redirects its recovery log
to `/pgdata/log`. Extract useful entries:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m shell \
  -a "find /pgdata/log -maxdepth 1 -type f -mmin -30 -exec
      grep -hE 'LOG:|WARNING:|ERROR:|FATAL:|PANIC:' {} + |
      grep -vE 'not yet accepting connections|Consistent recovery state has not been yet reached' |
      tail -200"
```

Healthy recovery includes `entering standby mode`, `started streaming WAL`,
`consistent recovery state reached`, and `ready to accept read-only
connections`.

## 10. Diagnose a node stuck in catchingup

Check streaming replication on the current primary:

```bash
ansible "$SURVIVING_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -X -d postgres -P pager=off -c \"
      SELECT application_name,
             client_addr,
             state,
             sync_state,
             sent_lsn,
             write_lsn,
             flush_lsn,
             replay_lsn,
             pg_size_pretty(
               pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
             ) AS replay_lag
      FROM pg_stat_replication;
      \""
```

A working rejoin shows the returning node address with `state=streaming`.

Check its recovery processes and network session:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" -b -m shell \
  -a "ps -eo pid,ppid,state,etime,cmd |
      grep -E '[p]ostgres.*(startup|walreceiver)|[p]ostgres -D';
      ss -ntp | grep '$SURVIVING_IP:5432' || true;
      nc -zvw3 '$SURVIVING_IP' 5432"
```

Expected evidence is a PostgreSQL startup/recovery process, a `walreceiver`,
an established connection to the current primary, and a successful port test.

Common diagnoses:

| Evidence | Diagnosis and action |
|---|---|
| No replication row; password failure in the log | Repair the vaulted `pgautofailover_replicator` credential. Never expose it in an ad-hoc command. |
| No replication row; `no pg_hba.conf entry` | Correct the primary HBA authorization for the returning node and reload PostgreSQL. |
| `requested WAL segment ... removed` | Preserve evidence and use the approved pg_autoctl reseed/base-backup process. Do not delete PGDATA without authorization. |
| Active walreceiver, zero lag, startup waiting at an exact segment boundary | Follow Section 11. |
| TLS private-key permission failure | Restore `postgres:postgres 0600` and let pg_autoctl retry. |
| Missing `/pgdata` mount | Stop recovery, correct storage/fstab, and then resume via pg_autoctl. |
| No space left | Resolve capacity through an approved change before retrying. |

## 11. Exact WAL-boundary diagnosis and remediation

The observed incident showed:

```text
Returning node: startup waiting for 00000016000000000000004C
Primary LSNs:  sent/write/flush/replay = 0/4C000000
Replication:   streaming
```

Timeline hexadecimal `16` is decimal 22. The returning node was waiting for
the first record in WAL segment `0/4C`, while the primary was positioned
exactly at `0/4C000000`. Networking and replication authentication were
healthy, but there was no later WAL record to replay to consistency.

Check the position:

```bash
ansible "$SURVIVING_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -X -d postgres -P pager=off -c \"
      SELECT pg_current_wal_lsn() AS primary_lsn;
      SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
             pg_size_pretty(
               pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
             ) AS replay_lag
      FROM pg_stat_replication;
      \""
```

Attempt a WAL switch:

```bash
ansible "$SURVIVING_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -XAtd postgres -c 'SELECT pg_switch_wal();'"
```

If PostgreSQL is already at a segment boundary and no WAL has been generated
since the previous switch, `pg_switch_wal()` may not advance the LSN. Generate
a checkpoint record and switch once:

```bash
ansible "$SURVIVING_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -X -d postgres -v ON_ERROR_STOP=1
      -c 'CHECKPOINT;'
      -c 'SELECT pg_switch_wal();'
      -c 'SELECT pg_current_wal_lsn();'"
```

This does not alter application data or HA roles. It may briefly increase I/O
and should be run only once for this diagnosed condition. Allow 30 to 120
seconds for recovery and monitor convergence. Verify Rubrik receives a new
WAL/log recovery point after the cluster is stable.

## 12. Validate the returned standby

Once it accepts connections:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -XAtd postgres -c 'SELECT pg_is_in_recovery();'"
```

Expected: `t`.

Read the receiver state:

```bash
ansible "$FAILED_NODE" -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -X -d postgres -P pager=off -c \"
      SELECT pg_last_wal_receive_lsn(),
             pg_last_wal_replay_lsn(),
             pg_last_xact_replay_timestamp();
      SELECT status, sender_host, sender_port, received_lsn,
             latest_end_lsn, latest_end_time
      FROM pg_stat_wal_receiver;
      \""
```

## 13. Final acceptance

Require stable state:

```bash
ansible db_monitor -i "$INVENTORY" \
  -b --become-user postgres -m command \
  -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

Required:

```text
Current primary: read-write  primary    primary
Returned node:   read-only   secondary  secondary
```

Recheck HAProxy using Section 6. Require the current primary `UP/PROCOK`, the
standby `DOWN/PROCERR`, the aggregate selector backend `UP`, and
`postgresql_write/local_pgbouncer` `UP` on both routers. Query the VIP and
require the current-primary address with `pg_is_in_recovery()=f`.

Run the standard health test:

```bash
INVENTORY="$INVENTORY" bash tests/run_health.sh --ask-vault-pass
```

Have the backup operator verify RBS health on both candidates, protection of
the promoted primary, and a new Rubrik WAL/log recovery point. Do not run the
legacy monitor-SSH WAL test when the provider is Rubrik.

## 14. Timing guidance

| Phase | Typical observation |
|---|---|
| Crash detection and promotion | Tens of seconds, depending on health and demotion timers |
| HAProxy write-target change | Several health-check intervals |
| pg_rewind | Depends on changed data and storage/network performance |
| Consistent recovery after rewind | Usually seconds to a few minutes |
| Full convergence | After the returned node reaches `secondary/secondary` |

Application writes can resume through `wait_primary` while the failed node is
still being repaired. Measure application recovery and full HA restoration as
separate intervals.

## 15. Stop and escalate

Stop manual action and escalate when:

- both nodes appear reachable and writable outside the HAProxy selector;
- the current primary cannot be identified unambiguously;
- the monitor is unavailable or contradicts direct database evidence;
- required WAL has already been removed;
- `pg_rewind` fails or requests a full base backup;
- a required filesystem is missing or mounted on the wrong device;
- logs report corruption, invalid checkpoints, PANIC, or repeated crashes;
- the surviving primary loses write availability;
- Rubrik restore/PITR or destructive PGDATA replacement is proposed.

Preserve monitor state, HAProxy state, pg_autoctl journal, PostgreSQL logs,
`pg_stat_replication`, mount information, timestamps, application outage,
timelines, rewind output, and Rubrik recovery-point evidence in the incident
record.

watch -n1 'sudo -u postgres psql -tAc "SELECT CASE WHEN pg_is_in_recovery() THEN '\''standby'\'' ELSE '\''primary'\'' END, COALESCE(EXTRACT(EPOCH FROM (now()-pg_last_xact_replay_timestamp()))::int,0);"'
