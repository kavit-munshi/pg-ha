# PostgreSQL 18 HA Deployment How-To

## Purpose

This guide explains how to deploy the five-node PostgreSQL 18 high-availability
platform from a Linux Ansible control machine. It is written as a copy-paste
runbook for operators who may not be familiar with Ansible.

The deployment creates:

- a PostgreSQL primary and standby managed by `pg_auto_failover`;
- a separate `pg_auto_failover` monitor;
- Rubrik-owned database and WAL protection in UAT and Production;
- two PgBouncer, HAProxy, and Keepalived routing hosts;
- a floating PostgreSQL virtual IP (VIP);
- Chrony time synchronization;
- role-based UFW firewall rules;
- Prometheus node, PostgreSQL, and PgBouncer exporters;
- provider-aware backup configuration with Rubrik as the UAT/Production owner.

The retired monitor SSH archive remains available only when
`postgresql_wal_archive_provider=monitor_ssh`. New deployments default to no
archive provider, while UAT and Production explicitly select `rubrik`. Rubrik
must be onboarded before the cleanup-tag deployment; see
`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.

> **Destructive storage warning**
>
> The storage role partitions and formats the configured data disks. Verify all
> VMware disks and device names before running `site.yml`. The OS disk
> `/dev/sda` is not modified, but `/dev/sdb` and `/dev/sdc` are used according
> to host role.
>
> Database `lv_data` must be mounted at `/pgdata/pgroot`. Do not mount it
> directly at PGDATA. The directories `/pgdata/pgroot/data` and
> `/pgdata/pgroot/backup` must remain ordinary sibling directories on that XFS
> filesystem. Existing hosts using the legacy mounted-PGDATA layout require an
> approved offline migration before this deployment is run.

## 1. Know the hosts

### UAT

| Host | IP | Role | Main services |
|---|---|---|---|
| `BHC-QMSSQLU05` | `192.168.129.105` | Initial database primary | PostgreSQL 18, pg_auto_failover |
| `BHC-QMSSQLU06` | `192.168.129.106` | Database standby | PostgreSQL 18, pg_auto_failover |
| `BHC-QMSSQLU07` | `192.168.129.107` | Monitor | Monitor PostgreSQL and pg_auto_failover |
| `BHC-PGBSQLU03` | `192.168.129.108` | Routing node 1 | Keepalived MASTER, HAProxy, PgBouncer |
| `BHC-PGBSQLU04` | `192.168.129.109` | Routing node 2 | Keepalived BACKUP, HAProxy, PgBouncer |

UAT uses VIP `192.168.129.110/24`, cluster CIDR `192.168.129.0/24`, and
application CIDR `192.168.24.0/24`.

### Production

| Host | IP | Role | Main services |
|---|---|---|---|
| `BHC-QMSSQLP01.bayshore.ca` | `192.168.128.134` | Initial database primary | PostgreSQL 18, pg_auto_failover |
| `BHC-QMSSQLP02.bayshore.ca` | `192.168.128.135` | Database standby | PostgreSQL 18, pg_auto_failover |
| `BHC-QMSSQLP03.bayshore.ca` | `192.168.128.136` | Monitor | Monitor PostgreSQL and pg_auto_failover |
| `BHC-PGBSQLP01.bayshore.ca` | `192.168.128.137` | Routing node 1 | Keepalived MASTER, HAProxy, PgBouncer |
| `BHC-PGBSQLP02.bayshore.ca` | `192.168.128.138` | Routing node 2 | Keepalived BACKUP, HAProxy, PgBouncer |

Production uses VIP/DNS `PGBQMSLSP01` (`192.168.128.139/24`), cluster CIDR
`192.168.128.0/24`, application CIDR `192.168.4.0/24`, and external Prometheus
server `BHC-PGMSQLP01` (`192.168.128.140`).

All hosts must already have:

- Ubuntu 24.04 LTS;
- an `ansible` user;
- the `ansible` user's SSH password;
- passwordless sudo through `/etc/sudoers.d/ansible`;
- working DNS or IP reachability from the control machine.

## 2. Prepare the Ansible control machine

Use Ubuntu 24.04, another supported Linux distribution, or WSL. Do not use
native Windows as the Ansible controller.

### 2.1 Install operating-system prerequisites

```bash
sudo apt update
sudo apt install -y git python3 python3-pip python3-venv sshpass
```

### 2.2 Create an isolated Ansible environment

```bash
python3 -m venv ~/.venvs/ansible-pg-ha
source ~/.venvs/ansible-pg-ha/bin/activate
python -m pip install --upgrade pip
python -m pip install "ansible-core>=2.17,<2.20" ansible-lint
ansible-playbook --version
```

Activate this environment again in every new terminal:

```bash
source ~/.venvs/ansible-pg-ha/bin/activate
```

### 2.3 Enter the repository and install collections

Replace `/path/to` with the actual parent directory:

```bash
cd /path/to/ansible-pg-ha
ansible-galaxy collection install -r requirements.yml
ansible-galaxy collection list
```

`requirements.yml` installs:

- `ansible.posix`;
- `community.general`;
- `community.postgresql`;
- `community.crypto`.

### 2.4 Generate the operator SSH key

The current bootstrap role reads `~/.ssh/id_rsa.pub`, so create an RSA key with
that exact filename:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
test -f ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa
chmod 600 ~/.ssh/id_rsa
chmod 644 ~/.ssh/id_rsa.pub
```

When `ssh-keygen` asks for a passphrase, using one is recommended. Load it into
the SSH agent before running Ansible:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_rsa
```

## 3. Configure environment values before deployment

### 3.1 Review UAT and Production addresses

Open both environment files:

```bash
nano group_vars/uat.yml
nano group_vars/prod.yml
```

Verify or replace:

- every `ansible_host` address in the selected inventory file;
- every host IP in `host_ips`;
- `cluster_cidr`;
- `prometheus_scrape_cidr`;
- every approved subnet in `application_client_cidrs`;
- `postgresql_vip` and `postgresql_vip_prefix`;
- `logstash_ip`;
- `ntp_servers`.

The repository's current environment network matrix is:

| Setting | UAT | Production |
|---|---|---|
| Inventory | `inventories/uat_hosts.ini` | `inventories/prod_hosts.ini` |
| Cluster CIDR | `192.168.129.0/24` | `192.168.128.0/24` |
| Application CIDR | `192.168.24.0/24` | `192.168.4.0/24` |
| VIP | `192.168.129.110/24` | `192.168.128.139/24` |
| VIP DNS | Not defined | `PGBQMSLSP01` |
| Prometheus source | `192.168.129.0/24` | `192.168.128.140/32` |

The `ansible_host` address and the corresponding `host_ips` value must match.
The former controls Ansible SSH connections; the latter is installed in the
managed PostgreSQL HA block in `/etc/hosts` on all five servers.

The inventory choice controls which environment group variables Ansible loads:

- `inventories/uat_hosts.ini` creates the `uat` group;
- `inventories/prod_hosts.ini` creates the `prod` group.

### 3.2 Review common settings

```bash
nano group_vars/all.yml
```

Confirm at least:

- environment-specific `keepalived_interface` matches the VIP-facing routing
  interface (`ens33` in the documented UAT environment);
- PostgreSQL memory values are appropriate for 32 GB database hosts;
- all storage devices and logical-volume sizes match VMware provisioning;
- `ufw_ssh_allowed_cidrs` contains the operator/control network;
- `ufw_database_allowed_cidrs` contains only approved database clients;
- `rubrik_allowed_cidrs` contains the approved Rubrik cluster/source addresses
  when `postgresql_wal_archive_provider` is `rubrik`;
- if a temporary `0.0.0.0/0` Rubrik source is approved, the environment also
  sets `rubrik_allow_world_source: true` and records the exception and expiry;
- NTP, exporter, VIP, and service ports are correct.

> **Firewall warning**
>
> `ufw_reset_rules: true` resets UFW on every playbook run and rebuilds only the
> declared role rules. Add approved exceptions to the Ansible role before
> deployment. Manually added rules will be removed on the next run.

### 3.3 Store secrets with Ansible Vault

Do not leave real passwords in `group_vars/uat.yml`, `group_vars/prod.yml`, or
`group_vars/all.yml`.

Generate one inline Vault block at a time. This helper reads the secret without
echoing it or placing it in shell history:

```bash
vault_var() {
  var_name="$1"
  read -rsp "Value for ${var_name}: " var_value
  echo
  printf '%s' "$var_value" |
    ansible-vault encrypt_string --ask-vault-pass --stdin-name "$var_name"
  unset var_value
}
```

Run it for every secret:

```bash
vault_var pg_auto_failover_monitor_password
vault_var pg_auto_failover_replication_password
vault_var app_db_password
vault_var postgres_exporter_password
vault_var haproxy_health_password
vault_var keepalived_auth_pass
```

Each command prints YAML similar to:

```yaml
app_db_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          ...
```

Copy each complete block into `group_vars/uat.yml`, replacing the corresponding
`CHANGE_ME` line. Generate a separate set of values and put those blocks in
`group_vars/prod.yml`. The Keepalived VRRP PASS value must be no more than eight
characters.

Do not create `group_vars/uat/` or `group_vars/prod/` directories alongside the
existing environment files; that changes how Ansible discovers group variables.

Test that the inventory resolves correctly:

```bash
ansible-inventory -i inventories/uat_hosts.ini --graph
ansible-inventory -i inventories/uat_hosts.ini --host BHC-QMSSQLU05 \
  --ask-vault-pass

ansible-inventory -i inventories/prod_hosts.ini --graph
ansible-inventory -i inventories/prod_hosts.ini \
  --host BHC-QMSSQLP01.bayshore.ca --ask-vault-pass
```

## 4. Step 1 — Push the SSH public key

The initial connection uses the existing `ansible` account password. Run:

```bash
ansible-playbook -i inventories/uat_hosts.ini bootstrap.yml --ask-pass --ask-vault-pass
```

At `SSH password:`, enter the SSH password for the `ansible` account. Input is
not displayed while typing.

For Production:

```bash
ansible-playbook -i inventories/prod_hosts.ini bootstrap.yml --ask-pass --ask-vault-pass
```

The bootstrap play:

1. creates `/home/ansible/.ssh` with mode `0700`;
2. installs the control machine's `~/.ssh/id_rsa.pub`;
3. enforces `authorized_keys` mode `0600`;
4. leaves ownership as `ansible:ansible`.

### Verify passwordless Ansible access

UAT:

```bash
ansible all -i inventories/uat_hosts.ini -m ping --ask-vault-pass
```

Production:

```bash
ansible all -i inventories/prod_hosts.ini -m ping --ask-vault-pass
```

Every host should return:

```text
SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

Do not continue until all five hosts return `pong`.

## 5. Verify disks and networking before formatting anything

Select UAT or Production and run read-only checks:

```bash
# UAT
export INVENTORY="$PWD/inventories/uat_hosts.ini"

# Production (use this instead for Production)
export INVENTORY="$PWD/inventories/prod_hosts.ini"

ansible-inventory -i "$INVENTORY" --graph

ansible all -i "$INVENTORY" -b -m command \
  -a "lsblk -e7 -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS"

ansible all -i "$INVENTORY" -b -m command \
  -a "ip -brief link"
```

Confirm:

| Inventory group | UAT hosts | Production hosts | Required data disks |
|---|---|---|---|
| `db_primary`, `db_standby` | U05, U06 | P01, P02 | `/dev/sdb`, at least 660 GiB usable |
| `db_monitor` | U07 | P03 | archive disk plus database LVM disk according to environment device variables; deployed Production archive is `/dev/sdc1` |
| `routing_nodes` | U03, U04 | routing P01, P02 | `/dev/sdb`, at least 120 GiB |

Also confirm:

- `/dev/sda` is the OS disk;
- the target data disks contain no data to retain;
- the routing interface name matches `keepalived_interface`;
- UDP 123 reaches the configured NTP servers;
- TCP 443 reaches Ubuntu and PostgreSQL package repositories;
- routing peers can exchange VRRP protocol 112;
- the configured VIP is unused.

Production storage is pre-provisioned and must be inspected rather than
reformatted. In the deployed Production monitor, the 405 GB archive filesystem
is `/dev/sdc1` mounted at `/pgdata/WalArchive`.

## 6. Step 2 — Deploy UAT

### 6.1 Run static checks

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml \
  --syntax-check --ask-vault-pass

ansible-lint site.yml bootstrap.yml
```

Resolve all syntax, undefined-variable, and inventory errors before proceeding.

### 6.2 Run the full deployment

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml --ask-vault-pass
```

Enter the Vault password when prompted.

### 6.3 Expected milestones

Typical elapsed time is 20–60 minutes on newly provisioned VMs. Repository
speed, disk speed, DNS, and PostgreSQL initialization can change this estimate.

| Approximate phase | What the output should show |
|---|---|
| 1–3 minutes | Input assertions, UFW reset/rule creation, Chrony installation |
| Up to 3 minutes | Each node reaches Chrony `Leap status: Normal` |
| 3–10 minutes | GPT partitions, LVM, XFS filesystems, persistent mounts |
| 5–20 minutes | PGDG packages and PostgreSQL 18 installed on database hosts |
| 1–5 minutes | Selected-environment monitor created |
| 2–10 minutes | Inventory `db_primary` host registered |
| 2–20 minutes | Inventory `db_standby` host clones and joins |
| 2–10 minutes | WAL SSH keys, users, archive configuration |
| 2–10 minutes | PgBouncer, HAProxy, Keepalived, VIP, exporters |

The final recap should show `failed=0` and `unreachable=0` for every host.
`changed` does not need to be zero on the first run.

Save the deployment transcript:

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml --ask-vault-pass \
  | tee "uat-deployment-$(date +%F-%H%M).log"
```

## 7. Step 3 — Deploy Production

Production must use reviewed Production IPs, CIDRs, VIP, NTP sources, and Vault
secrets. Confirm `keepalived_interface`, verify that every inventory name has an
exact `host_ips` key, and re-run disk/interface checks first. When Production
LVM, XFS, mounts, and `/etc/fstab` are already provisioned, keep
`storage_lvm_enabled: false` and explicitly skip storage:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --syntax-check --ask-vault-pass

ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --skip-tags storage -e storage_lvm_enabled=false --ask-vault-pass \
  | tee "prod-deployment-$(date +%F-%H%M).log"
```

Do not use `--limit` for the first deployment. The monitor, primary, and standby
plays depend on their declared sequence. The preflight must resolve the five
Production hosts listed in Section 1 and must reject every remaining
`CHANGE_ME` guard value.

## 8. Step 4 — Post-deployment verification

### 8.0 Upgrade an existing fixed-pair routing deployment

Apply this architecture change to UAT first. The command updates only the two
routing nodes, removes the obsolete external 6432 UFW rule, converts PgBouncer
to loopback, and installs the HAProxy primary selector:

```bash
ansible-playbook -i inventories/uat_hosts.ini site.yml \
  --limit routing_nodes \
  --tags firewall,routing \
  --ask-vault-pass
```

Run the health and database-failover tests described below. Promote the same
Git revision to Production only after UAT proves that both local poolers follow
both database roles. Then run:

```bash
ansible-playbook -i inventories/prod_hosts.ini site.yml \
  --limit routing_nodes \
  --tags firewall,routing \
  --ask-vault-pass
```

The routing play converts the backup-preferred router first and processes one
router at a time. Keep an application retry policy active: pooled connections
to the old database can be closed when primary eligibility changes.

Select the environment once before using the commands in this section:

```bash
# UAT
export INVENTORY="$PWD/inventories/uat_hosts.ini"
export DB_MONITOR=BHC-QMSSQLU07
export ROUTER_PRIMARY=BHC-PGBSQLU03

# Production (use these three lines instead for Production)
export INVENTORY="$PWD/inventories/prod_hosts.ini"
export DB_MONITOR=BHC-QMSSQLP03.bayshore.ca
export ROUTER_PRIMARY=BHC-PGBSQLP01.bayshore.ca
```

Confirm the selected inventory before running a test:

```bash
ansible-inventory -i "$INVENTORY" --graph
```

### 8.1 Check for failed services

```bash
ansible all -i "$INVENTORY" -b -m command \
  -a "systemctl --failed --no-pager"
```

No required service should appear in the failed state.

### 8.2 Check PostgreSQL HA state

Query the selected environment's monitor:

```bash
ansible db_monitor -i "$INVENTORY" \
  -b --become-user postgres -m command \
  -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
```

Expected:

- both selected-environment data nodes are listed;
- one node has primary state;
- the other has secondary state;
- assigned and reported states settle to stable values.

Check the local systemd service on all database hosts:

```bash
ansible db_cluster -i "$INVENTORY" -b -m command \
  -a "systemctl status pg_autoctl --no-pager"
```

Check synchronous replication from the current primary:

```bash
ansible db_primary -i "$INVENTORY" \
  -b --become-user postgres -m shell \
  -a "psql -d postgres -Atc 'SHOW synchronous_commit; SHOW synchronous_standby_names;'"
```

### 8.3 Check Chrony synchronization and drift

```bash
ansible all -i "$INVENTORY" -m command -a "chronyc tracking"
ansible all -i "$INVENTORY" -m command -a "chronyc sources"
```

Expected:

- `Leap status` is `Normal`;
- `System time` offset is small and stable;
- the selected source in `chronyc sources` has a `^*` marker.

### 8.4 Check LVM, XFS, mounts, and fstab

```bash
ansible db_cluster -i "$INVENTORY" -b -m command -a "pvs"
ansible db_cluster -i "$INVENTORY" -b -m command -a "vgs"
ansible db_cluster -i "$INVENTORY" -b -m command -a "lvs"

ansible all -i "$INVENTORY" -b -m shell \
  -a "df -Th /pgdata /pgdata/* 2>/dev/null || true"

ansible db_primary:db_standby -i "$INVENTORY" -b -m command \
  -a "findmnt /pgdata/pgroot/data/pg_wal"

ansible db_cluster -i "$INVENTORY" -b -m command \
  -a "mountpoint /pgdata/pgroot/data"

ansible db_cluster -i "$INVENTORY" -b -m shell \
  -a "stat -c '%d %n' /pgdata/pgroot/data /pgdata/pgroot/backup"
```

Expected:

- data filesystems are XFS;
- database logical volumes belong to `vg_pgdata`;
- all required `/pgdata/*` mount points are present;
- `/pgdata/pgroot` is the XFS `lv_data` mountpoint;
- `/pgdata/pgroot/data` is a normal directory, not a mountpoint;
- `/pgdata/pgroot/data` and `/pgdata/pgroot/backup` have the same device ID;
- `/pgdata/pgroot/data/pg_wal` is a bind mount backed by `/pgdata/wal`;
- mounts appear in `/etc/fstab`.

### 8.5 Check UFW policy and role ports

```bash
ansible all -i "$INVENTORY" -m command \
  -a "sudo ufw status verbose"
```

Every host must show:

- `Status: active`;
- logging enabled;
- default incoming `deny`;
- default outgoing `allow`;
- TCP 22 and 9100;
- DB hosts: TCP 5432 and 9187;
- DB primary/standby hosts: inbound TCP 12800 and 12801 from every approved
  entry in `rubrik_allowed_cidrs` when Rubrik is selected;
- DB primary/standby hosts: outbound TCP 111, 9639, and 32764:32769 plus
  outbound UDP 111 and 32764:32769 to every approved Rubrik destination;
- routing hosts: TCP 5432 and 9127;
- routing hosts: PgBouncer 6432 and the HAProxy selector 6433 remain loopback-only;
- routing hosts: a VRRP rule restricted to the other router.

Rubrik WAL/log and NFS connections are initiated outbound by the PostgreSQL
hosts. Do not open ports 9639, 111, or 32764:32769 as inbound database-host
listeners. Apply external-firewall rules using the same directions, exact
Rubrik endpoint addresses, and the matrix approved for the installed release.

### 8.6 Check Keepalived VIP ownership

```bash
ansible routing_nodes -i "$INVENTORY" -b -m shell \
  -a "ip -brief address show dev {{ keepalived_interface }}"
```

Use the selected environment's `keepalived_interface`. The VIP should appear on
exactly one routing node.

Check services:

```bash
ansible routing_nodes -i "$INVENTORY" -b -m command \
  -a "systemctl status pgbouncer haproxy keepalived --no-pager"
```

### 8.7 Check HAProxy

Read the HAProxy runtime socket:

```bash
ansible routing_nodes -i "$INVENTORY" -b -m shell \
  -a 'echo "show stat" | socat stdio /run/haproxy/admin.sock'
```

`postgresql_write/local_pgbouncer` should be UP. Exactly one server in
`postgresql_primary_selector` should be UP, and it must be the current writable
PostgreSQL primary.

Check the local statistics page:

```bash
ansible routing_nodes -i "$INVENTORY" -m uri \
  -a "url=http://127.0.0.1:8404/stats status_code=200"
```

Port 8404 is intentionally not opened by UFW for remote access.

### 8.8 Check PgBouncer directly

SSH to a routing node:

```bash
ssh "ansible@${ROUTER_PRIMARY}"
```

Then run:

```bash
read -rsp "PgBouncer exporter password: " PGPASSWORD
echo
export PGPASSWORD
psql -h 127.0.0.1 -p 6432 -U pgbouncer_exporter pgbouncer \
  -c "SHOW POOLS;"
unset PGPASSWORD
```

Repeat on the other routing host. `SHOW POOLS` should return pool statistics
without an authentication error.

Also test the data path on both routing hosts with the application login:

```bash
PGPASSWORD='<app_db_password>' \
psql "host=127.0.0.1 port=6432 dbname=qms user=qms_app sslmode=require" \
  -Atc "SELECT host(inet_server_addr()), pg_is_in_recovery();"
PGPASSWORD='<app_db_password>' \
psql "host=127.0.0.1 port=6433 dbname=qms user=qms_app sslmode=require" \
  -Atc "SELECT host(inet_server_addr()), pg_is_in_recovery();"
```

Both results must identify the same writable primary and end in `|f`.

### 8.9 Test the complete VIP connection path

Run this from a host inside one of the `application_client_cidrs`:

```bash
read -rsp "Application database password: " PGPASSWORD
echo
export PGPASSWORD
psql "host=<POSTGRESQL_VIP> port=5432 dbname=qms user=qms_app sslmode=require" \
  -c "SELECT inet_server_addr(), inet_server_port(), pg_is_in_recovery();"
unset PGPASSWORD
```

Replace `<POSTGRESQL_VIP>` with the environment VIP. Expected:

- connection succeeds through VIP → HAProxy → local PgBouncer → local HAProxy
  primary selector → PostgreSQL;
- `pg_is_in_recovery` is `false`;
- `inet_server_addr` identifies the current primary.

### 8.10 Check Prometheus exporter endpoints

From a host inside `prometheus_scrape_cidr`:

```bash
curl -fsS http://<ANY_NODE_IP>:9100/metrics | head
curl -fsS http://<DB_NODE_IP>:9187/metrics | head
curl -fsS http://<ROUTING_NODE_IP>:9127/metrics | head
```

### 8.11 Check Rubrik backup ownership

Run the provider-aware health test and confirm both data nodes report
`wal_level=replica`, `archive_mode=on`, and a non-legacy archive command or
library. Confirm the old timer and `/usr/local/sbin/archive-wal` are absent.
The backup operator must separately attach the latest successful Rubrik base
backup, WAL/log recovery point and isolated restore/PITR evidence. Follow
`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.

### 8.12 Run the automated read-only health test

The test wrappers default to UAT. Always set `INVENTORY` explicitly for
Production and inspect the graph before execution:

```bash
ansible-inventory -i "$INVENTORY" --graph
bash tests/run_health.sh --ask-vault-pass
```

For a one-command Production invocation:

```bash
INVENTORY="$PWD/inventories/prod_hosts.ini" \
  bash tests/run_health.sh --ask-vault-pass
```

Do not run `run_routing_failover.sh`, `run_db_failover.sh`, or
`RUN_DISRUPTIVE=true tests/run_all.sh` in Production without an approved
maintenance window.

## 9. Optional controlled failover test

Perform this only in an approved maintenance window.

1. Record the current primary:

   ```bash
   ansible "$DB_MONITOR" -i "$INVENTORY" -b --become-user postgres \
     -m command -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
   ```

2. On the current primary, stop pg_autoctl:

   ```bash
   sudo systemctl stop pg_autoctl
   ```

3. Watch state on the selected environment monitor:

   ```bash
   watch -n 2 \
     "ansible '$DB_MONITOR' -i '$INVENTORY' -b --become-user postgres \
     -m command -a 'pg_autoctl show state --pgdata /pgdata/pgroot/data'"
   ```

4. Repeat the VIP SQL test. It must reach the promoted node and return
   `pg_is_in_recovery() = false`.

5. Restore the old primary:

   ```bash
   sudo systemctl start pg_autoctl
   ```

6. Wait for it to rejoin as a stable secondary.

Do not use `pg_ctl promote`; pg_auto_failover owns state transitions.

## 10. Troubleshooting and common gotchas

### SSH host-key prompt or changed host key

Ansible sets `host_key_checking = False`, so bootstrap should not block on an
interactive prompt. Direct `ssh` commands may still prompt.

For a brand-new host, verify the fingerprint through the approved VMware or
server-build record, then accept it.

If a VM was rebuilt and the old key is cached:

```bash
ssh-keygen -R <ENVIRONMENT_HOSTNAME>
ssh-keygen -R <HOST_IP>
ssh-keyscan -H <HOST_IP> >> ~/.ssh/known_hosts
```

Verify the new fingerprint through a trusted channel before accepting it.

### Bootstrap reports authentication failure

Check:

```bash
ssh ansible@<HOST_IP>
sudo -n true
ls -l /etc/sudoers.d/ansible
```

The same `ansible` password must work on all targeted hosts when one
`--ask-pass` prompt is used.

### Chrony synchronization times out

Check:

```bash
sudo systemctl status chrony --no-pager
chronyc tracking
chronyc sources -v
getent hosts 0.ca.pool.ntp.org
```

Confirm DNS and outbound UDP 123. If public pools are blocked, replace
`ntp_servers` with approved internal NTP names and rerun `site.yml`.

### Standby waits for primary registration and times out

Do not delete PGDATA immediately. Check the authoritative monitor state:

```bash
ansible "$DB_MONITOR" -i "$INVENTORY" -b --become-user postgres \
  -m command -a "pg_autoctl show state --pgdata /pgdata/pgroot/data"
ansible "$DB_MONITOR" -i "$INVENTORY" -b -m command \
  -a "journalctl -u pg_autoctl -n 200 --no-pager"
```

On the inventory `db_primary` host:

```bash
sudo systemctl status pg_autoctl --no-pager
sudo journalctl -u pg_autoctl -n 200 --no-pager
sudo -u postgres pg_isready -h 127.0.0.1 -p 5432
```

Verify:

- the inventory `db_primary` host is registered on the monitor;
- both data nodes can reach the selected monitor on TCP 5432;
- monitor password and URI values match;
- clocks are synchronized;
- UFW permits `cluster_cidr`;
- PostgreSQL HBA contains the Ansible-managed pg_auto_failover block.

After fixing the cause, rerun the complete play:

```bash
ansible-playbook -i "$INVENTORY" site.yml --ask-vault-pass
```

### Both HAProxy backends are down

On a routing node:

```bash
sudo -u haproxy env HAPROXY_SERVER_ADDR=<DATABASE_NODE_IP> \
  HAPROXY_SERVER_PORT=5432 \
  /usr/local/sbin/check-pg-primary
echo $?
```

Exit status `0` means that database node is the writable primary. Run the check
for both data-node IPs; exactly one should return `0`. Check
`/etc/haproxy/pg-primary-check.env`, direct PostgreSQL reachability, the
`haproxy_check` login, and `pg_is_in_recovery()`.

### UFW removed an emergency rule

This is expected when `ufw_reset_rules: true`. Add the approved exception to
the `ufw_firewall` role or its variables, review it, and rerun the playbook.

### Rubrik WAL/log protection fails

Check `pg_stat_archiver`, `/pgdata/wal` capacity, the effective Rubrik archive
command/library, RBS service and Rubrik job events. Escalate before WAL capacity
becomes critical. Do not re-enable the monitor archive while Rubrik is active;
use the approved rollback procedure in
`RUBRIK_WAL_CUTOVER_AND_DR_RUNBOOK.md`.

## 11. Safe re-runs

The playbook is designed to be re-run after correcting a failure:

```bash
ansible-playbook -i "$INVENTORY" site.yml --ask-vault-pass
```

Important behavior:

- storage modules preserve existing matching partitions, LVs, filesystems, and
  mounts;
- `creates` guards prevent normal PostgreSQL reinitialization;
- templates restart services only when configuration changes;
- polling waits for monitor and node readiness;
- UFW is intentionally reset and rebuilt on every full run;
- the database/WAL play uses `serial: 1` to avoid restarting database hosts
  simultaneously;
- the routing play uses `serial: 1` and reverse inventory order so the backup
  router is converted before the preferred VIP owner.

Do not manually remove LVM objects, PGDATA, pg_autoctl state, or archive keys
unless an approved rebuild procedure explicitly requires it.

The routing tier is updated one host at a time, backup-preferred router first.
Brief connection resets remain possible when old pooled server sessions are
closed during the topology change; applications must retry failed transactions.
