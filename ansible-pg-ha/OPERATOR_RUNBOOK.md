# Operator runbook: PostgreSQL 18 HA and routing tier

## 1. Scope and resulting topology

The playbooks provision the following hardened Ubuntu 24.04 hosts:

| Host | Function | Database/routing behavior |
|---|---|---|
| `BHC-QMSSQLU05` | Initial PostgreSQL primary | pg_auto_failover data node; PgBouncer U03 is paired to it |
| `BHC-QMSSQLU06` | Synchronous standby | pg_auto_failover data node; PgBouncer U04 is paired to it |
| `BHC-QMSSQLU07` | pg_auto_failover monitor and WAL archive | Monitor database plus `/pgdata/WalArchive` |
| `BHC-PGBSQLU03` | Routing node 1 | Keepalived MASTER priority 101, HAProxy, PgBouncer |
| `BHC-PGBSQLU04` | Routing node 2 | Keepalived BACKUP priority 100, HAProxy, PgBouncer |

Client writes enter the Keepalived VIP on TCP 5432. HAProxy's external health
check maps each PgBouncer backend to its paired PostgreSQL node and accepts the
backend only when `SELECT pg_is_in_recovery()` returns `false`. After a
pg_auto_failover promotion, HAProxy therefore selects the PgBouncer paired with
the new primary.

WAL is archived from both database candidates with `archive_command` and a
dedicated Ed25519 key. The archive script sends each completed segment to
`BHC-QMSSQLU07:/pgdata/WalArchive` using an atomic `.partial` rename.

## 2. Safety and prerequisites

The storage role partitions and formats the named data disks. Before running it,
confirm VMware presents exactly these devices and that they contain no data to
retain:

- U05/U06: `/dev/sdb`, at least 660 GiB usable
- U07: `/dev/sdb`, at least 400 GiB; `/dev/sdc`, at least 660 GiB usable
- U03/U04: `/dev/sdb`, at least 120 GiB

On database hosts, `lv_data` is mounted at `/pgdata/pgroot`. PGDATA is the
ordinary directory `/pgdata/pgroot/data`, and pg_autoctl stages backups at
`/pgdata/pgroot/backup`. Never mount a filesystem directly at PGDATA: standby
creation removes PGDATA and atomically renames the completed sibling backup.
Migrate any existing legacy layout during approved downtime before deployment.

The 40 GiB OS disk `/dev/sda` is not modified. Verify every node manually:

```bash
lsblk -e7 -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
sudo pvs
sudo vgs
sudo lvs
ip -br link
```

Confirm the routing VIP-facing NIC name. UAT currently uses `ens33`; configure
`keepalived_interface` independently in `group_vars/uat.yml` and
`group_vars/prod.yml`.

Network prerequisites:

- Control server to all nodes: TCP 22
- All five nodes inside `cluster_cidr`: PostgreSQL 5432 and PgBouncer 6432
- VRRP unicast between U03 and U04
- Application CIDR to routing nodes/VIP: TCP 5432
- Prometheus CIDR to all nodes: 9100; DB nodes: 9187; routers: 9127 and 8404
- DB candidates to monitor/archive node: TCP 22 and 5432
- All target nodes to the configured NTP servers: UDP 123
- Target nodes to `apt.postgresql.org` and Ubuntu repositories: TCP 443

The pre-existing `ansible` account must have `NOPASSWD: ALL`.

The `ufw_firewall` role resets UFW on every run before rebuilding the declared
rules. This is intentional enforcement: unmanaged legacy rules cannot leave
extra ports exposed. Add any approved exception to the role variables/tasks
before deployment; do not add it manually with `ufw`, because the next run will
remove it. Restrict `ufw_ssh_allowed_cidrs` in `group_vars/all.yml` when the
control-server and operator source networks are known.

The automation enables encrypted PostgreSQL and PgBouncer connections with
self-signed certificates and `sslmode=require`. This encrypts traffic but does
not authenticate the server against a trusted CA. Before Production, replace
the generated certificates with certificates issued by the enterprise PKI and
change clients to CA-verifying `sslmode=verify-full`.

## 3. Prepare the Ansible control server

Use Ubuntu 24.04, another supported Linux control host, or WSL. Install the
control packages:

```bash
sudo apt update
sudo apt install -y python3-pip python3-venv sshpass git
python3 -m venv ~/.venvs/ansible-pg-ha
source ~/.venvs/ansible-pg-ha/bin/activate
python -m pip install --upgrade pip
python -m pip install "ansible-core>=2.17,<2.20" ansible-lint
```

Create the exact RSA key expected by `bootstrap.yml` if it does not exist:

```bash
test -f ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_rsa
chmod 644 ~/.ssh/id_rsa.pub
```

Install required Ansible collections from the repository root:

```bash
cd ansible-pg-ha
ansible-galaxy collection install -r requirements.yml
```

## 4. Set environment variables and secrets

Review all values in:

- `group_vars/uat.yml`
- `group_vars/prod.yml`
- `group_vars/all.yml`

At minimum, replace the sample IP addresses, CIDRs, VIP, NIC name, Logstash
address, and every `CHANGE_ME`. Keep the Keepalived `auth_pass` at 1-8
characters because that is the VRRP PASS limit.

Do not commit plaintext production credentials. Generate inline Vault values:

```bash
read -rsp "Production application password: " secret_value
echo
printf '%s' "$secret_value" |
  ansible-vault encrypt_string --ask-vault-pass \
  --stdin-name app_db_password
unset secret_value
```

Copy the complete generated YAML block into `group_vars/prod.yml`, replacing
the matching `CHANGE_ME` line. Repeat for all six secrets and for UAT. Supply
`--ask-vault-pass` or a protected `--vault-password-file` to commands that load
the environment variables.

Validate inventory resolution before touching hosts:

```bash
ansible-inventory -i inventories/uat_hosts.ini --graph
ansible-inventory -i inventories/uat_hosts.ini --host BHC-QMSSQLU05
```

## 5. Bootstrap SSH keys with password authentication

The first connection uses the existing `ansible` account and its password:

```bash
ansible-playbook -i inventories/uat_hosts.ini bootstrap.yml --ask-pass
```

For Production:

```bash
ansible-playbook -i inventories/prod_hosts.ini bootstrap.yml --ask-pass
```

The role installs the control operator's `~/.ssh/id_rsa.pub`, enforces
`/home/ansible/.ssh` mode 0700, and enforces `authorized_keys` mode 0600.

Test key authentication:

```bash
ansible -i inventories/uat_hosts.ini all_nodes -m ping
```

## 6. Preflight and deploy UAT

Syntax and reachability checks:

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml --syntax-check
ansible -i inventories/uat_hosts.ini all_nodes -b -m command -a \
  "lsblk -e7 -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS"
ansible -i inventories/uat_hosts.ini all_nodes -b -m command -a \
  "ip -br link"
```

Run the complete UAT deployment with key authentication:

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml --ask-vault-pass
```

Omit `--ask-vault-pass` only if secret variables are supplied by another secure
Ansible mechanism. The play order is deliberate: common storage/tuning,
monitor, initial primary, standby, database/WAL configuration, routing, then
monitoring.

Re-run the same command after a failure. Tasks use persistent markers, module
state, and pg_autoctl registration checks; do not manually delete PGDATA to
force a retry.

## 7. Deploy Production

Repeat all disk, interface, IP, and firewall checks against the Production
inventory. Then run:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml --syntax-check
ansible-playbook -i inventories/prod_hosts.ini site.yml --ask-vault-pass
```

Use `--limit` only for non-sequencing maintenance after the initial build. The
first deployment must use the full `site.yml` ordering.

## 8. Verify storage and services

On all nodes:

```bash
findmnt -t xfs
systemctl --failed
systemctl status prometheus-node-exporter --no-pager
curl -fsS http://127.0.0.1:9100/metrics >/dev/null
```

Check NTP synchronization status across all cluster nodes:

```bash
ansible all -i inventories/uat_hosts.ini -m command -a "chronyc tracking"
ansible all -i inventories/uat_hosts.ini -m command -a "chronyc sources"
```

Every host should report `Leap status: Normal`. In `chronyc sources`, the
selected source is marked with `^*`. Resolve NTP reachability or DNS failures
before proceeding with database failover testing.

Check the enforced UFW policy and role-specific rules across all nodes:

```bash
ansible all -i inventories/uat_hosts.ini -m command \
  -a "sudo ufw status verbose"
```

Every node must report `Status: active`, default incoming `deny`, default
outgoing `allow`, and only its role-specific rules. Common rules are SSH 22 and
node exporter 9100. Database nodes additionally expose 5432 and 9187. Routing
nodes additionally expose 5432, 6432, 9127, plus a VRRP rule restricted to the
other routing node.

On U05/U06, verify the WAL bind mount and pg_autoctl:

```bash
findmnt /pgdata/pgroot
mountpoint /pgdata/pgroot/data
stat -c '%d %n' /pgdata/pgroot/data /pgdata/pgroot/backup
findmnt /pgdata/pgroot/data/pg_wal
systemctl status pg_autoctl --no-pager
sudo -u postgres pg_autoctl show state --pgdata /pgdata/pgroot/data
```

`/pgdata/pgroot/data` must not be a mountpoint. The two `stat` device numbers
must match so pg_autoctl can atomically rename a completed base backup to
PGDATA.

The authoritative cluster view is on U07:

```bash
sudo -u postgres pg_autoctl show state --pgdata /pgdata/pgroot/data
sudo -u postgres pg_autoctl show uri --pgdata /pgdata/pgroot/data
```

Expected result: U05 and U06 are both present; one is primary and the other is
secondary. Wait until both report stable assigned and reported states before
testing failover.

Verify synchronous commit while the standby is healthy:

```bash
sudo -u postgres psql -d postgres -c \
  "SHOW synchronous_commit; SHOW synchronous_standby_names;"
```

`synchronous_commit` must be `on` and `synchronous_standby_names` must identify
an eligible standby. pg_auto_failover manages that name dynamically and removes
it when no healthy standby is available, favoring write availability over
blocking all commits.

## 9. Verify VIP, HAProxy, and PgBouncer

On both routing nodes:

```bash
systemctl status pgbouncer haproxy keepalived --no-pager
ip -brief address show dev ens33
echo "show stat" | sudo socat stdio /run/haproxy/admin.sock
curl -fsS http://127.0.0.1:8404/stats >/dev/null
```

The VIP should appear on only one router. Install `socat` for the runtime-socket
command if it is not already present.

Check PgBouncer locally, substituting the Vault value:

```bash
PGPASSWORD='<postgres_exporter_password>' \
psql -h 127.0.0.1 -p 6432 -U pgbouncer_exporter pgbouncer -c 'SHOW POOLS;'
```

Check the complete application path through the VIP:

```bash
PGPASSWORD='<app_db_password>' \
psql "host=<VIP> port=5432 dbname=qms user=qms_app sslmode=require" \
  -c "SELECT inet_server_addr(), pg_is_in_recovery();"
```

`pg_is_in_recovery` must be `false`.

## 10. Verify monitoring and WAL archiving

From an allowed Prometheus host:

```bash
curl -fsS http://<any-node-ip>:9100/metrics | head
curl -fsS http://<db-node-ip>:9187/metrics | head
curl -fsS http://<routing-node-ip>:9127/metrics | head
```

Force a WAL switch on the primary and verify arrival on U07:

```bash
sudo -u postgres psql -d postgres -c "SELECT pg_switch_wal();"
sudo -u postgres psql -d postgres -c \
  "SELECT archived_count, failed_count, last_archived_wal, last_failed_wal FROM pg_stat_archiver;"
```

On U07:

```bash
sudo -u postgres ls -lh /pgdata/WalArchive | tail
```

The included Rubrik hook is inert by default. After installing and validating
the RBS agent, set `rubrik_rbs_enabled: true`, set
`rubrik_rbs_hook_command`, and re-run `site.yml`.

## 11. Controlled failover test

Schedule this test in a maintenance window. Record the current primary:

```bash
sudo -u postgres pg_autoctl show state --pgdata /pgdata/pgroot/data
```

On the current primary, stop pg_autoctl:

```bash
sudo systemctl stop pg_autoctl
```

Watch the monitor until the standby becomes primary:

```bash
watch -n 2 "sudo -u postgres pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

Repeat the VIP application query. It must still return
`pg_is_in_recovery() = false`, and `inet_server_addr()` should now identify the
promoted node. Restore the stopped node:

```bash
sudo systemctl start pg_autoctl
```

Wait for it to rejoin as a stable secondary. Do not promote nodes manually with
`pg_ctl`; pg_auto_failover owns database state transitions.

## 12. Troubleshooting

Useful logs:

```bash
journalctl -u pg_autoctl -u pgbouncer -u haproxy -u keepalived -n 200 --no-pager
journalctl -u prometheus-postgres-exporter \
  -u prometheus-pgbouncer-exporter -n 100 --no-pager
tail -n 100 /pgdata/log/postgresql-*.log
```

If both HAProxy backends are down, run the external check manually on a router:

```bash
sudo -u haproxy env HAPROXY_SERVER_ADDR=<router-ip> \
  /usr/local/sbin/check-pg-primary
```

If WAL archiving fails, test the exact service-account path from the current
primary:

```bash
sudo -u postgres ssh -i /var/lib/postgresql/.ssh/id_ed25519_wal_archive \
  postgres@<monitor-ip> 'test -w /pgdata/WalArchive'
sudo -u postgres psql -d postgres -c \
  "SELECT * FROM pg_stat_archiver;"
```

Correct the underlying network, permission, certificate, or secret issue and
re-run `site.yml`; avoid deleting LVM volumes, PGDATA, or pg_autoctl state.
