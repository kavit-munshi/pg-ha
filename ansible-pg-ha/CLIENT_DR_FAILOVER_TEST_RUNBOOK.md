# Client DR Readiness and Failover Test Runbook

## 1. Purpose

This runbook provides automated and manual procedures for a client-observed
PostgreSQL HA and disaster-recovery-readiness exercise.

The standard exercise proves:

- baseline platform health;
- a completed WAL segment reaches the monitor archive;
- the routing VIP moves to the peer router and SQL remains writable;
- pg_auto_failover performs a controlled database switchover;
- HAProxy follows the promoted writable primary;
- routing and database topology return to the starting state;
- final health checks pass.

The standard exercise does not restore a physical base backup or perform PITR.
A true restore test requires an isolated recovery host, a verified base backup,
the required WAL chain, and the procedure in
`DB_BACKUP_AND_RECOVERY_RUNBOOK.md`. Do not describe this failover exercise as
proof of backup restorability.

## 2. Risk and expected impact

| Phase | Expected impact |
|---|---|
| Health checks | Read-only |
| WAL test | Creates a restore point and forces one WAL switch |
| Routing failover | Brief TCP reconnect while the VIP moves |
| Database switchover | Existing sessions can disconnect; applications must reconnect |
| Restoration switchover | A second brief database reconnect |

Run only in an approved maintenance window. Application connection pools must
retry connections to the VIP. Do not test against direct database-node IPs.

## 3. Client and operator roles

| Role | Responsibility |
|---|---|
| Exercise commander | Authorizes each disruptive phase and owns stop/go decisions |
| PostgreSQL operator | Runs Ansible/manual database commands and watches monitor state |
| VMware operator | Provides console access and fencing if a VM behaves unexpectedly |
| Network operator | Observes VIP, VRRP, firewall, and routing behavior |
| Application owner | Stops batch work, observes reconnect behavior, validates transactions |
| Backup operator | Confirms latest base backup/WAL protection and records restore-test gap |
| Scribe | Records timestamps, results, screenshots, and incidents |

## 4. Preconditions and go/no-go gate

Do not begin until all items are confirmed:

- approved change/incident number and maintenance window;
- client bridge, escalation contacts, and VMware console access;
- explicit UAT or Production inventory selection;
- passwordless Ansible SSH and sudo to all five nodes;
- working Vault password source;
- no active deployment, backup restore, host maintenance, or network change;
- pg_auto_failover reports stable primary/secondary states;
- exactly one routing node owns the VIP;
- application owners accept two reconnect events;
- recent WAL archive success and adequate WAL/archive free space;
- latest available physical base backup and its verification status recorded;
- rollback decision owner present.

Stop criteria:

- zero or two writable database nodes;
- both routers own the VIP or neither can acquire it;
- replication is not stable before database testing;
- WAL/archive filesystem is near critical capacity;
- application cannot reconnect after the agreed threshold;
- the `always` restoration phase fails;
- any unexpected data-integrity result.

If a stop criterion occurs, stop further testing, preserve logs, keep unsafe
nodes fenced, and follow `DB_BACKUP_AND_RECOVERY_RUNBOOK.md`.

## 5. Environment selection

UAT:

```bash
export INVENTORY="$PWD/inventories/uat_hosts.ini"
```

Production:

```bash
export INVENTORY="$PWD/inventories/prod_hosts.ini"
```

Confirm before every disruptive command:

```bash
ansible-inventory -i "$INVENTORY" --graph
```

## 6. Automated Ansible exercise

### 6.1 Syntax and lint validation

```bash
ansible-playbook -i "$INVENTORY" --syntax-check \
  tests/playbooks/client_dr_failover.yml

ansible-lint --project-dir . tests

bash -n tests/run_client_dr_failover.sh
```

### 6.2 Run the exercise

```bash
export CLIENT_DR_TEST_ID="CHG123456-client-witnessed"
bash tests/run_client_dr_failover.sh --ask-vault-pass
```

The wrapper has no default inventory. It requires typing one of:

```text
UAT-CLIENT-DR-FAILOVER
PROD-CLIENT-DR-FAILOVER
```

It runs one Ansible process in this order:

1. authorization and exercise identity validation;
2. baseline comprehensive health;
3. forced WAL archive test;
4. routing VIP failover and automatic restoration;
5. intermediate health validation;
6. controlled database switchover and automatic switchback;
7. final comprehensive health;
8. completion report.

Evidence is written to:

```text
artifacts/client-dr/<test-id>.log
```

The application owner should run a continuous business-safe read/write probe
through the VIP during the routing and database phases. Do not place the
application password on the command line or in the evidence log.

## 7. Manual exercise procedure

Use this procedure when the client wants explicit hold points between phases.

### 7.1 Phase 0: baseline and evidence

Record UTC time and Git revision:

```bash
date -u --iso-8601=seconds
git rev-parse HEAD
ansible-inventory -i "$INVENTORY" --graph
```

Run health validation:

```bash
bash tests/run_health.sh --ask-vault-pass
```

On the monitor, capture cluster state:

```bash
sudo -u postgres pg_autoctl show state \
  --pgdata /pgdata/pgroot/data
```

On both data nodes:

```bash
sudo -u postgres psql -X -At -d postgres -c \
  "SELECT host(inet_server_addr()), pg_is_in_recovery(), \
          CASE WHEN pg_is_in_recovery() \
               THEN pg_last_wal_replay_lsn()::text \
               ELSE pg_current_wal_lsn()::text END;"
```

On both routers:

```bash
ip -br -4 address
systemctl is-active keepalived haproxy pgbouncer
```

Require exactly one VIP owner and one writable database before continuing.

### 7.2 Phase 1: WAL archive test

Automated single phase:

```bash
bash tests/run_wal_archive_test.sh --ask-vault-pass
```

Manual equivalent on the current primary:

```bash
sudo -u postgres psql -X -d postgres -c \
  "SELECT pg_create_restore_point( \
     'client_dr_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));"

sudo -u postgres psql -X -At -d postgres -c \
  "SELECT pg_walfile_name(pg_switch_wal());"
```

Record the returned filename. On the monitor:

```bash
sudo -u postgres test -f \
  "/pgdata/WalArchive/<RETURNED_WAL_FILENAME>"

sudo -u postgres ls -l \
  "/pgdata/WalArchive/<RETURNED_WAL_FILENAME>"
```

On the primary:

```bash
sudo -u postgres psql -X -d postgres -c \
  "SELECT archived_count, failed_count, last_archived_wal, \
          last_archived_time, last_failed_wal, last_failed_time \
   FROM pg_stat_archiver;"
```

Hold point: client and backup operator confirm WAL evidence.

### 7.3 Phase 2: routing VIP failover

Determine the VIP owner:

```bash
ansible routing_nodes -i "$INVENTORY" -b -m shell \
  -a "hostname; ip -o -4 address show dev {{ keepalived_interface }}"
```

Set the actual inventory names after reviewing the output:

```bash
export ORIGINAL_ROUTER='<CURRENT_VIP_OWNER_INVENTORY_NAME>'
export PEER_ROUTER='<OTHER_ROUTER_INVENTORY_NAME>'
```

Confirm SQL works through the VIP before disruption using the approved
application probe.

Stop Keepalived only on the current VIP owner:

```bash
ansible "$ORIGINAL_ROUTER" -i "$INVENTORY" -b \
  -m systemd -a "name=keepalived state=stopped"
```

Verify the peer owns the VIP:

```bash
ansible "$PEER_ROUTER" -i "$INVENTORY" -b -m shell \
  -a "ip -o -4 address show dev {{ keepalived_interface }}"
```

Run the client SQL probe through the unchanged VIP. Record reconnect time and
transaction result.

Restore Keepalived:

```bash
ansible "$ORIGINAL_ROUTER" -i "$INVENTORY" -b \
  -m systemd -a "name=keepalived enabled=true state=started"
```

Verify exactly one VIP owner and SQL success after restoration. If the
preferred router does not reclaim the VIP, inspect Keepalived priority and
`nopreempt` policy rather than moving the address manually.

Hold point: client confirms routing failover and restoration.

### 7.4 Phase 3: controlled database switchover

On the monitor, record the original primary and require stable
`primary/primary` and `secondary/secondary` states:

```bash
sudo -u postgres pg_autoctl show state \
  --pgdata /pgdata/pgroot/data
```

Start the controlled switchover from the monitor:

```bash
sudo -u postgres pg_autoctl perform switchover \
  --pgdata /pgdata/pgroot/data \
  --formation default \
  --group 0 \
  --wait 120
```

Watch state:

```bash
watch -n 2 "sudo -u postgres pg_autoctl show state \
  --pgdata /pgdata/pgroot/data"
```

Require the former standby to become stable primary and the former primary to
become stable secondary. Run the application probe through the VIP and confirm
it reaches the promoted node with `pg_is_in_recovery() = false`.

Hold point: client confirms database switchover.

Restore the original topology with the same supported command:

```bash
sudo -u postgres pg_autoctl perform switchover \
  --pgdata /pgdata/pgroot/data \
  --formation default \
  --group 0 \
  --wait 120
```

Do not use `pg_ctl promote`.

### 7.5 Phase 4: final validation

```bash
bash tests/run_health.sh --ask-vault-pass
bash tests/run_wal_archive_test.sh --ask-vault-pass
```

Require:

- original primary/secondary topology restored, unless the approved test plan
  intentionally leaves roles reversed;
- exactly one VIP owner;
- SQL through the VIP reaches a writable primary;
- synchronous streaming healthy;
- WAL archiving successful;
- all required timers/exporters/services active;
- no unexplained failed systemd unit;
- application-owner transaction validation complete.

## 8. Optional automatic primary-outage simulation

This optional test is more disruptive than a controlled switchover. It stops
`pg_autoctl` on the current primary and waits for the monitor to promote the
standby. It is not part of `run_client_dr_failover.sh`.

Run only with separate written approval, VMware fencing capability, confirmed
backup status, and an application outage/reconnect plan.

1. Record current primary, monitor state, and replication lag.
2. On the current primary only:

   ```bash
   sudo systemctl stop pg_autoctl
   ```

3. Watch monitor state from the monitor node.
4. Verify the standby becomes writable and VIP SQL follows it.
5. Restore the stopped node:

   ```bash
   sudo systemctl start pg_autoctl
   ```

6. Wait for it to rejoin as a stable secondary.
7. Leave the new primary in place unless a separately approved controlled
   switchover is required.

If promotion does not occur, do not issue manual promotion commands. Preserve
state and escalate through the database recovery runbook.

## 9. True backup/PITR DR test

A complete DR certification additionally requires:

1. select a verified physical base backup;
2. prove the required WAL/timeline chain exists;
3. restore into an isolated network with no route to the Production VIP,
   monitor, or archive destination;
4. run `pg_verifybackup` before recovery;
5. start with `recovery.signal` and approved `restore_command`;
6. replay to an approved UTC target or named restore point;
7. validate business data read-only;
8. record measured RPO and RTO;
9. destroy or retain the isolated recovery environment according to policy.

This phase cannot be automated against the live five-node environment. Follow
Section 14 of `DB_BACKUP_AND_RECOVERY_RUNBOOK.md` after the designed base-backup
solution is implemented and a DR recovery host is provisioned.

## 10. Evidence and acceptance

Capture:

```text
Change/exercise ID:
Environment and inventory:
Git revision:
Client participants:
UTC/local start and end:
Initial primary and VIP owner:
WAL segment archived:
Routing VIP move duration:
Application reconnect duration:
Promoted database node:
Database switchover duration:
Original topology restored:
Final health result:
Latest base-backup ID/status:
Latest isolated restore test date:
Exceptions/incidents:
Client acceptance/signature:
```

Success requires every automated/manual assertion to pass and the client
application owner to confirm business-safe connectivity before, during, and
after both failover events.

