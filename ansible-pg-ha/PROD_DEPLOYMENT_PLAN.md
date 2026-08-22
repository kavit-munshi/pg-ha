# PostgreSQL HA Production Deployment Plan

## 1. Status

The Production inventory and network variables have been prepared from the
approved server list. Deployment must not begin until every item marked
`REQUIRED` in Section 4 is resolved.

No Production password is stored in this document.

## 2. Production topology

| Inventory group | Hostname | IP address | Initial role |
|---|---|---:|---|
| `db_primary` | `BHC-QMSSQLP01.bayshore.ca` | `192.168.128.134` | PostgreSQL primary |
| `db_standby` | `BHC-QMSSQLP02.bayshore.ca` | `192.168.128.135` | Synchronous standby |
| `db_monitor` | `BHC-QMSSQLP03.bayshore.ca` | `192.168.128.136` | pg_auto_failover monitor |

Rubrik is the Production database and archived-WAL protection owner. The
legacy monitor archive must remain disabled except during an approved rollback;
see `RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.
| `routing_nodes` | `BHC-PGBSQLP01` | `192.168.128.137` | Preferred VIP owner, HAProxy, PgBouncer |
| `routing_nodes` | `BHC-PGBSQLP02` | `192.168.128.138` | Backup VIP owner, HAProxy, PgBouncer |

External/unmanaged endpoints:

| Name | IP address | Purpose |
|---|---:|---|
| `PGBQMSLSP01` | `192.168.128.139` | Floating PostgreSQL application VIP |
| `BHC-PGMSQLP01` | `192.168.128.140` | Central Prometheus scraper |

Network settings:

| Setting | Value |
|---|---|
| Cluster network | `192.168.128.0/24` |
| Application client network | `192.168.4.0/24` |
| Prometheus allowed source | `192.168.128.140/32` |
| VIP prefix | `/24` |
| Application endpoint | `PGBQMSLSP01:5432` / `192.168.128.139:5432` |
| Database | `qms` |
| Application role | `qms_app` |

The Prometheus host is intentionally not in `all_nodes`. This repository
installs exporters on the five PostgreSQL platform servers but does not install
or configure the central Prometheus server.

## 3. Files prepared

- `inventories/prod_hosts.ini`
- `group_vars/prod.yml`
- VIP DNS support in the managed host mappings
- VIP DNS SAN support in new PgBouncer certificates

## 4. Required decisions before deployment

### 4.1 REQUIRED — confirm the VIP-facing interface

`keepalived_interface` remains `CHANGE_ME` intentionally. On both routing
servers, run:

```bash
ip -br -4 address
ip route get 192.168.128.139
```

The interface must own `192.168.128.137` on P01 and `192.168.128.138` on P02.
Set that identical interface name in `group_vars/prod.yml`.

### 4.2 REQUIRED — confirm hostnames and DNS

Confirm forward and reverse resolution for all five hosts, Prometheus, and VIP:

```bash
getent hosts BHC-QMSSQLP01.bayshore.ca
getent hosts BHC-QMSSQLP02.bayshore.ca
getent hosts BHC-QMSSQLP03.bayshore.ca
getent hosts BHC-PGBSQLP01
getent hosts BHC-PGBSQLP02
getent hosts BHC-PGMSQLP01
getent hosts PGBQMSLSP01
```

Confirm whether the routing hosts and VIP should use short names or
`.bayshore.ca` FQDNs. Ansible sets each managed host's canonical hostname to its
inventory name.

The VIP address must be reserved and unused before Keepalived starts:

```bash
ping -c 3 192.168.128.139
arping -D -I <VIP_INTERFACE> 192.168.128.139
```

### 4.3 REQUIRED — confirm storage ownership

`storage_lvm_enabled` remains `false` to prevent accidental repartitioning.
Before deployment, confirm the required LVM, XFS, mounts, and `/etc/fstab`
entries already exist on every server.

Database nodes and monitor:

```bash
sudo pvs
sudo vgs
sudo lvs
findmnt /pgdata/pgroot
findmnt /pgdata/wal
findmnt /pgdata/log
findmnt /pgdata/tmp
findmnt /pgdata/binaries
findmnt /pgdata/dbinst
grep -E '/pgdata/' /etc/fstab
```

Monitor archive:

```bash
findmnt /pgdata/WalArchive
df -Th /pgdata/WalArchive
```

Routing nodes:

```bash
findmnt /pgdata
df -Th /pgdata
```

If storage has not been provisioned exactly as designed, stop and reconcile
the actual device names and sizes before changing `storage_lvm_enabled`.

### 4.4 REQUIRED — create unique Production secrets

Replace all six `CHANGE_ME` guards in `group_vars/prod.yml`:

- `pg_auto_failover_monitor_password`
- `pg_auto_failover_replication_password`
- `app_db_password`
- `postgres_exporter_password`
- `haproxy_health_password`
- `keepalived_auth_pass`

Use unique Production values. Do not copy UAT credentials. Keepalived VRRP PASS
is limited to 1–8 characters by the deployed validation.

Example:

```bash
ansible-vault encrypt_string --ask-vault-pass \
  --name app_db_password
```

Paste the complete `!vault` result under the matching variable. Validate that
no `CHANGE_ME` value remains:

```bash
grep -nE \
  '^(pg_auto_failover_monitor_password|pg_auto_failover_replication_password|app_db_password|postgres_exporter_password|haproxy_health_password|keepalived_auth_pass): CHANGE_ME$' \
  group_vars/prod.yml
```

Expected result: no output after all required secrets are replaced. The separate
interface and optional Logstash placeholders are tracked in their own sections.

### 4.5 REQUIRED — approve Production NTP sources

The current file retains regional Canadian NTP pools as placeholders. Replace
them with approved internal Production NTP addresses if external NTP is blocked
or prohibited. Verify UDP/123 reachability before deployment.

### 4.6 REQUIRED — confirm network policy

Confirm these flows:

| Source | Destination | Protocol/port | Purpose |
|---|---|---|---|
| `192.168.4.0/24` | VIP `192.168.128.139` | TCP/5432 | Application database traffic |
| `192.168.128.140/32` | all five nodes | TCP/9100 | Node metrics |
| `192.168.128.140/32` | three DB hosts | TCP/9187 | PostgreSQL metrics |
| `192.168.128.140/32` | two routing hosts | TCP/9127 | PgBouncer metrics |
| Cluster nodes | DB/monitor nodes | TCP/5432 | PostgreSQL, replication, monitor |
| Routing peers | Routing peers | VRRP/112 | VIP heartbeat |
| Approved management network | all five nodes | TCP/22 | Administration/Ansible |
| Data nodes | monitor | TCP/22 | Retained rollback keys; not active WAL transport |
| All nodes | approved NTP | UDP/123 | Clock synchronization |

Update `ufw_ssh_allowed_cidrs` before Production if SSH must not remain open
from any source.

### 4.7 REQUIRED — decide external integrations

- `BHC-PGMSQLP01` must be configured separately with scrape targets.
- Logstash forwarding is disabled. `logstash_ip` remains `CHANGE_ME` and is not
  used while `configure_logstash_forwarding` is false.
- Rubrik must be installed, approved and have a successful base backup plus
  durable WAL configuration before `rubrik_wal_cutover_confirmed=true` is used.
- Add only the vendor-approved Rubrik firewall sources, directions and ports;
  do not open broad inbound rules without the final network design.
- Enterprise CA certificates are not currently provided; generated
  certificates are self-signed.

## 5. Control-server preparation

From the repository root:

```bash
ansible-galaxy collection install -r requirements.yml
ansible-lint --project-dir "$PWD" . tests
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --syntax-check --ask-vault-pass
ansible-inventory -i inventories/prod_hosts.ini --graph \
  --ask-vault-pass
```

Review resolved non-secret variables:

```bash
ansible-inventory -i inventories/prod_hosts.ini \
  --host BHC-QMSSQLP01.bayshore.ca --yaml --ask-vault-pass
```

Do not save decrypted inventory output in tickets or shared logs.

## 6. Bootstrap SSH access

The `ansible` account and passwordless sudo must exist on all five managed
servers. Push the control-server public key using the initial SSH password:

```bash
ansible-playbook -i inventories/prod_hosts.ini bootstrap.yml \
  --ask-pass --ask-vault-pass
```

Verify key-based access:

```bash
ansible all_nodes -i inventories/prod_hosts.ini -m ping \
  --ask-vault-pass
```

Do not continue unless all five hosts return `SUCCESS`.

## 7. Read-only preflight

Confirm operating system and interfaces:

```bash
ansible all_nodes -i inventories/prod_hosts.ini -b -m shell \
  -a "hostname -f; lsb_release -ds; ip -br -4 address" \
  --ask-vault-pass
```

Confirm the VIP is unused and host mappings match the approved list. Confirm
there is no existing PostgreSQL cluster, PgBouncer service, or Keepalived VIP
that would conflict with this deployment.

## 8. Deployment

Run in an approved Production change window:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --ask-vault-pass
```

Do not interrupt `pg_autoctl create postgres`, `pg_basebackup`, filesystem
operations, or service handlers unless the deployment is demonstrably stuck
and the recovery impact has been assessed.

## 9. Post-deployment validation

Set the test inventory:

```bash
export INVENTORY="$PWD/inventories/prod_hosts.ini"
```

Run read-only health validation:

```bash
bash tests/run_health.sh --ask-vault-pass
```

Confirm the latest successful Rubrik base backup and WAL/log recovery point.
Do not run the legacy monitor-WAL test while the Production provider is Rubrik.
Follow `RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md` for cutover and restore evidence.

During an approved disruptive-test window:

```bash
bash tests/run_routing_failover.sh --ask-vault-pass
bash tests/run_db_failover.sh --ask-vault-pass
```

Validate application connectivity from `192.168.4.0/24`:

```bash
psql "host=PGBQMSLSP01 port=5432 dbname=qms user=qms_app sslmode=require" \
  -c "SELECT host(inet_server_addr()), pg_is_in_recovery();"
```

Expected outcome: the query reaches the current writable primary and reports
`pg_is_in_recovery = false`.

## 10. Prometheus onboarding

Configure `BHC-PGMSQLP01` to scrape:

```text
192.168.128.134:9100
192.168.128.135:9100
192.168.128.136:9100
192.168.128.137:9100
192.168.128.138:9100

192.168.128.134:9187
192.168.128.135:9187
192.168.128.136:9187

192.168.128.137:9127
192.168.128.138:9127
```

Prometheus configuration, retention, dashboards, alert rules, and notification
routing are owned outside this repository.

## 11. Go/no-go record

| Item | Owner | Evidence | Status |
|---|---|---|---|
| Hostnames/IPs/DNS approved | `[OWNER]` | `[REFERENCE]` | Open |
| VIP reserved and unused | `[OWNER]` | `[REFERENCE]` | Open |
| Routing interface confirmed | `[OWNER]` | `[REFERENCE]` | Open |
| LVM/XFS/mounts/fstab verified | `[OWNER]` | `[REFERENCE]` | Open |
| Production secrets vaulted | `[OWNER]` | `[REFERENCE]` | Open |
| NTP sources approved/reachable | `[OWNER]` | `[REFERENCE]` | Open |
| Firewall flows approved | `[OWNER]` | `[REFERENCE]` | Open |
| Backup/Rubrik policy approved | `[OWNER]` | `[REFERENCE]` | Open |
| Prometheus onboarding assigned | `[OWNER]` | `[REFERENCE]` | Open |
| Change and rollback plan approved | `[OWNER]` | `[REFERENCE]` | Open |
| Application outage/retry plan approved | `[OWNER]` | `[REFERENCE]` | Open |

Production deployment is **NO-GO** until every required line is complete.
