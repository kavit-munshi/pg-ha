# PostgreSQL 18 HA Ansible Codebase Architecture

## 1. Document purpose

This document is the engineering reference for the PostgreSQL 18
high-availability Ansible repository. It explains repository structure,
inventory and variable resolution, play sequencing, every role and template,
traffic flow, state ownership, security boundaries, and re-run behavior.

For operator commands, use `DEPLOYMENT_HOWTO.md`.

## 2. Platform topology

The targets are VMware virtual machines running Ubuntu 24.04 LTS. Database
nodes use PostgreSQL 18 from the official PGDG repository.

| Inventory group | Host | Sizing | Function |
|---|---|---:|---|
| `db_primary` | `BHC-QMSSQLU05` | 16 vCPU, 32 GB, ~700 GB | Initial PostgreSQL primary |
| `db_standby` | `BHC-QMSSQLU06` | 16 vCPU, 32 GB, ~700 GB | Initial synchronous standby |
| `db_monitor` | `BHC-QMSSQLU07` | 8 vCPU, 16 GB, ~1.1 TB | pg_auto_failover monitor and WAL archive |
| `routing_nodes` | `BHC-PGBSQLU03` | 8 vCPU, 16 GB, ~160 GB | PgBouncer/HAProxy and initial VIP MASTER |
| `routing_nodes` | `BHC-PGBSQLU04` | 8 vCPU, 16 GB, ~160 GB | PgBouncer/HAProxy and initial VIP BACKUP |

`db_cluster` contains all three database-side hosts. `all_nodes` contains
`db_cluster` and `routing_nodes`.

### 2.1 Client write path

```text
Application
    |
    | PostgreSQL protocol, VIP:5432
    v
Keepalived VIP on one routing node
    |
    v
HAProxy postgresql_write listener
    |
    | external check selects only the pooler paired with a writable DB
    v
PgBouncer:6432
    |
    | transaction pooling, TLS required to PostgreSQL
    v
Current PostgreSQL primary:5432
```

### 2.2 Routing pair design

Each PgBouncer has a fixed database candidate:

| Routing host | `routing_slot` | PgBouncer database target |
|---|---|---|
| U03 | `primary` | U05 |
| U04 | `standby` | U06 |

HAProxy on both routing hosts lists both PgBouncer instances as backends.
Before enabling a backend, `/usr/local/sbin/check-pg-primary` maps the backend
routing IP to its paired PostgreSQL IP and executes:

```sql
SELECT pg_is_in_recovery();
```

Only `false` is accepted. After pg_auto_failover promotes U06, HAProxy disables
the U03/U05 path and enables the U04/U06 path. The fixed pairing therefore
follows promotions without rewriting PgBouncer configuration.

## 3. Repository layout (complete)

```text
ansible-pg-ha/
├── .gitignore
├── ansible.cfg
├── bootstrap.yml
├── site.yml
├── requirements.yml
├── README.md
├── OPERATOR_RUNBOOK.md
├── DEPLOYMENT_HOWTO.md
├── CODEBASE_ARCHITECTURE.md
├── inventories/
│   ├── uat_hosts.ini
│   └── prod_hosts.ini
├── group_vars/
│   ├── all.yml
│   ├── uat.yml
│   └── prod.yml
├── tests/
│   ├── README.md
│   ├── run_health.sh
│   ├── run_wal_archive_test.sh
│   ├── run_routing_failover.sh
│   ├── run_db_failover.sh
│   ├── run_all.sh
│   └── playbooks/
│       ├── health.yml
│       ├── wal_archive.yml
│       ├── routing_failover.yml
│       └── db_failover.yml
└── roles/
    ├── push_ssh_keys/
    │   └── tasks/
    │       └── main.yml
    ├── ufw_firewall/
    │   └── tasks/
    │       └── main.yml
    ├── storage_lvm/
    │   └── tasks/
    │       └── main.yml
    ├── os_tuning/
    │   ├── handlers/
    │   │   └── main.yml
    │   ├── tasks/
    │   │   └── main.yml
    │   └── templates/
    │       └── chrony.conf.j2
    ├── pg_auto_failover/
    │   ├── handlers/
    │   │   └── main.yml
    │   ├── tasks/
    │   │   ├── main.yml
    │   │   ├── monitor.yml
    │   │   └── postgres_node.yml
    │   └── templates/
    │       ├── pg_autoctl.service.j2
    │       └── postgresql-ha.conf.j2
    ├── pgbouncer/
    │   ├── handlers/
    │   │   └── main.yml
    │   ├── tasks/
    │   │   └── main.yml
    │   └── templates/
    │       ├── pgbouncer.ini.j2
    │       └── userlist.txt.j2
    ├── keepalived_haproxy/
    │   ├── handlers/
    │   │   └── main.yml
    │   ├── tasks/
    │   │   └── main.yml
    │   └── templates/
    │       ├── check-pg-primary.sh.j2
    │       ├── haproxy.cfg.j2
    │       ├── keepalived.conf.j2
    │       └── pg-primary-check.env.j2
    ├── monitoring_agents/
    │   ├── handlers/
    │   │   └── main.yml
    │   ├── tasks/
    │   │   └── main.yml
    │   └── templates/
    │       ├── logstash-forwarding.conf.j2
    │       ├── pgbouncer-exporter.env.j2
    │       ├── postgres-exporter.env.j2
    │       └── prometheus-pgbouncer-exporter.conf.j2
    └── backup_wal/
        ├── handlers/
        │   └── main.yml
        ├── tasks/
        │   └── main.yml
        └── templates/
            ├── archive-wal.sh.j2
            ├── postgresql-archive.conf.j2
            └── rubrik-rbs-hook.sh.j2
```

Secret values can be stored as inline `!vault` scalars in `uat.yml` and
`prod.yml`. Directory-form group variables are not used because the repository
already uses file-form environment variables.

## 4. Top-level configuration

## 4.1 `ansible.cfg`

| Setting | Value | Effect |
|---|---|---|
| `inventory` | `./inventories/uat_hosts.ini` | UAT is the default only when `-i` is omitted |
| `roles_path` | `./roles` | Resolves short role names locally |
| `collections_paths` | user and system paths | Finds Galaxy-installed collections |
| `host_key_checking` | `False` | Prevents first-run host-key prompts during bootstrap |
| `stdout_callback` | `yaml` | Produces readable structured task output |
| `interpreter_python` | `auto_silent` | Suppresses interpreter discovery noise |
| `retry_files_enabled` | `False` | Avoids legacy `.retry` files |
| `timeout` | `30` | SSH connection timeout |
| `pipelining` | `True` | Reduces SSH round trips for module execution |
| `ControlMaster/ControlPersist` | enabled | Reuses SSH connections for 60 seconds |
| `become` | enabled | Uses sudo by default |

The `yaml` callback is why `community.general` is constrained below version 12
in `requirements.yml`; that callback was removed in later collection releases.

`host_key_checking=False` improves unattended bootstrap behavior but removes an
SSH identity check. Production operators should verify fingerprints through
the VMware/build process and may enable checking after keys and known-host
entries are established.

## 4.2 `requirements.yml`

| Collection | Used for |
|---|---|
| `ansible.posix` | mounts, sysctl, authorized keys |
| `community.general` | partitioning, LVM, filesystems, UFW |
| `community.postgresql` | databases, roles, memberships |
| `community.crypto` | SSH and TLS keys/certificates |

`community.general >=10.3` is required for `proto: vrrp` in the UFW module.

## 5. Inventory design

Both INI inventories expose the same logical topology:

```ini
[db_primary]
BHC-QMSSQLU05

[db_standby]
BHC-QMSSQLU06

[db_monitor]
BHC-QMSSQLU07

[routing_nodes]
BHC-PGBSQLU03 routing_slot=primary
BHC-PGBSQLU04 routing_slot=standby
```

Child groups compose the topology:

```text
all_nodes
├── db_cluster
│   ├── db_primary
│   ├── db_standby
│   └── db_monitor
└── routing_nodes
```

The UAT inventory adds all nodes to group `uat`; the Production inventory adds
them to group `prod`. Those environment groups trigger the corresponding
variable file.

### 5.1 Why `routing_slot` exists

`routing_slot` is a host variable used by two roles:

- `pgbouncer` chooses U05 for `primary` and U06 for `standby`;
- `keepalived_haproxy` chooses MASTER/priority 101 for `primary` and
  BACKUP/priority 100 for `standby`.

It describes initial routing placement, not the current PostgreSQL state.
HAProxy determines current write eligibility dynamically.

## 6. Variable hierarchy

Practical precedence from lowest to higher for this repository is:

1. `group_vars/all.yml`;
2. `group_vars/uat.yml` or `group_vars/prod.yml`;
3. inventory host variables such as `routing_slot`;
4. play/task facts set with `set_fact`;
5. command-line extra variables, if used.

### 6.1 Common variables

`group_vars/all.yml` owns:

- Ansible connection defaults;
- PostgreSQL version, ports, paths, and tuning;
- PgBouncer pool limits;
- HAProxy and Keepalived settings;
- Chrony service and fallback NTP sources;
- exporter users and ports;
- UFW enforcement and source lists;
- storage device, VG, LV, and mount definitions;
- Logstash and Rubrik feature flags;
- guarded secret defaults.

Each inventory host declares an explicit `ansible_host`. This is deliberately
not derived from `inventory_hostname`: that magic variable continues to refer
to the original host during delegation and could otherwise route a delegated
monitor command back to the standby. The matching environment `host_ips` map
is used by service templates, firewall rules, and the Ansible-managed block in
`/etc/hosts` on every node.

The `os_tuning` role validates that all members of `all_nodes` have a mapping,
then maintains the complete mapping between marked lines in `/etc/hosts`.
`blockinfile` makes the operation idempotent and preserves unrelated local
entries.

### 6.2 Environment variables

`uat.yml` and `prod.yml` own:

- `deployment_environment`;
- `host_ips`;
- `cluster_cidr`;
- `prometheus_scrape_cidr`;
- `application_client_cidr`;
- PostgreSQL VIP and prefix;
- Logstash address;
- environment NTP sources;
- placeholder secret overrides.

### 6.3 Secret guard

The first `site.yml` play asserts that all secret values differ from
`CHANGE_ME`. The recommended method is to replace each placeholder in the
existing environment file with an inline `!vault` encrypted scalar generated
by `ansible-vault encrypt_string`.

Sensitive templates/tasks use `no_log` where Ansible would otherwise display
password-bearing content.

## 7. Playbooks and execution flow

## 7.1 `bootstrap.yml`

Target: `all_nodes`.

Purpose: establish public-key SSH authentication while password authentication
is still required.

It explicitly sets `ansible_user: ansible`, disables fact gathering, elevates
with the pre-existing passwordless sudo configuration, and runs only
`push_ssh_keys`.

## 7.2 `site.yml`

The ordering is a dependency graph:

```text
Validate variables
    |
    v
UFW -> Chrony/OS tuning -> storage
    |
    v
pg_auto_failover monitor
    |
    v
initial primary
    |
    v
standby
    |
    v
database users and WAL archive (serial: 1)
    |
    v
PgBouncer -> HAProxy/Keepalived
    |
    v
monitoring agents
```

Important ordering properties:

- SSH is permitted before UFW is enabled.
- Chrony must report `Leap status: Normal` before cluster initialization.
- The monitor exists before any data node registers.
- U05 registers before U06 attempts to join.
- WAL/archive changes are serialized across database hosts.
- HAProxy starts before Keepalived advertises the VIP.
- exporters are installed after their database/pooler users exist.

## 8. Role deep dives

## 8.1 `push_ssh_keys`

Target: all nodes through `bootstrap.yml`.

Actions:

1. creates `/home/ansible/.ssh` as `ansible:ansible`, mode `0700`;
2. reads the control-side `~/.ssh/id_rsa.pub` with a lookup;
3. installs it with `ansible.posix.authorized_key`;
4. enforces `authorized_keys` mode `0600`.

The role does not generate a control-side key and does not currently look for
`id_ed25519.pub`.

## 8.2 `ufw_firewall`

Target: all nodes, first role in the preparation play.

The role installs UFW, optionally resets all prior rules, applies defaults,
adds role rules, enables logging, enables boot persistence, and verifies
verbose status.

### Firewall matrix

| Host scope | Destination | Source |
|---|---:|---|
| All nodes | 22/tcp | `ufw_ssh_allowed_cidrs` |
| All nodes | 9100/tcp | `metrics_allowed_cidr` |
| DB cluster | 5432/tcp | `ufw_database_allowed_cidrs` |
| DB cluster | 9187/tcp | `metrics_allowed_cidr` |
| Routing | 5432/tcp | `application_client_cidr` |
| Routing | 6432/tcp | `cluster_cidr` |
| Routing | 9127/tcp | `metrics_allowed_cidr` |
| Routing | VRRP/112 | other router IP only |

Defaults are incoming deny and outgoing allow. UFW logging is on.

`ufw_reset_rules: true` is deliberate desired-state enforcement. It also means
the role reports changes and briefly rebuilds UFW on each full run. Unmanaged
manual rules do not survive.

HAProxy statistics port 8404 is bound by HAProxy but not opened externally by
UFW. It is intended for local inspection unless an explicitly reviewed rule is
added.

## 8.3 `os_tuning`

Target: all nodes after UFW.

### Packages and host identity

Installs baseline packages including ACL, CA certificates, curl, GnuPG, and
rsync. It sets the canonical hostname to `inventory_hostname` and maintains an
Ansible block in `/etc/hosts` for all five cluster hosts.

### Chrony

Installs `chrony` and renders `/etc/chrony/chrony.conf`:

```text
server <server> iburst maxpoll 6
driftfile /var/lib/chrony/chrony.drift
makestep 1.0 3
rtcsync
logdir /var/log/chrony
```

- `iburst` accelerates initial source sampling.
- `maxpoll 6` caps the polling interval at 64 seconds.
- `makestep 1.0 3` permits a step for offsets over one second during the first
  three updates.
- `rtcsync` periodically aligns the real-time clock.

The Chrony handler restarts the Ubuntu `chrony` unit after configuration
changes. The role polls `chronyc tracking` for up to about three minutes and
requires `Leap status: Normal`. Failure blocks PostgreSQL and Keepalived
initialization.

### Kernel tuning

The role writes these settings to `/etc/sysctl.conf`:

| Setting | Value | Intent |
|---|---:|---|
| `vm.swappiness` | 10 | Avoid aggressive swapping |
| `vm.overcommit_memory` | 2 | Use strict virtual-memory accounting |
| `net.core.somaxconn` | 4096 | Increase the pending socket queue |

### Resource limits

It adds managed blocks to `/etc/security/limits.conf`:

| User | Limit | Value |
|---|---|---:|
| `postgres` | soft/hard `nofile` | 65536 |
| `postgres` | soft/hard `nproc` | 4096 |
| `pgbouncer` | soft/hard `nofile` | 65536 |
| `pgbouncer` | soft/hard `nproc` | 4096 |

Each block is conditional on the relevant inventory group.

## 8.4 `storage_lvm`

Target: all nodes, with tasks selected by inventory membership.

Installs `lvm2` and `xfsprogs`. Device assertions intentionally restrict the
implemented layouts to `/dev/sdb` and `/dev/sdc`.

### Database nodes U05/U06

1. Creates GPT `/dev/sdb1` with the LVM flag.
2. Uses the partition as a PV through `community.general.lvg`.
3. Creates `vg_pgdata`.
4. Creates and formats:

| LV | Size | Mount |
|---|---:|---|
| `lv_data` | 100 GiB | `/pgdata/pgroot` |
| `lv_wal` | 300 GiB | `/pgdata/wal` |
| `lv_log` | 30 GiB | `/pgdata/log` |
| `lv_tmp` | 30 GiB | `/pgdata/tmp` |
| `lv_binaries` | 100 GiB | `/pgdata/binaries` |
| `lv_dbinst` | 100 GiB | `/pgdata/dbinst` |

### Monitor/archive U07

- `/dev/sdc1` supplies `vg_pgdata` and the same LV set.
- `/dev/sdb1` is a separate 400 GiB XFS filesystem mounted at
  `/pgdata/WalArchive`.

### Routing nodes U03/U04

- `/dev/sdb1` is a 120 GiB XFS filesystem mounted at `/pgdata`.

All mounts use `defaults,noatime` and `ansible.posix.mount state=mounted`,
which both mounts immediately and creates persistent `/etc/fstab` entries.
Filesystem creation does not use `force`, and LVs use `shrink: false`.

`/pgdata/pgroot` is the data-filesystem mountpoint. PostgreSQL uses the normal
directory `/pgdata/pgroot/data`, while pg_autoctl stages base backups in the
sibling directory `/pgdata/pgroot/backup`. The role rejects a mounted PGDATA
or different device IDs for these directories because pg_autoctl atomically
renames the completed backup directory to PGDATA.

## 8.5 `pg_auto_failover`

Target: monitor, then initial primary, then standby in separate ordered plays.

### Common installation

The role:

1. installs the PostgreSQL PGDG signing key;
2. configures the Ubuntu release-specific PGDG repository;
3. installs PostgreSQL 18, client tools, `postgresql-18-auto-failover`,
   `pg-auto-failover-cli`, and Psycopg;
4. detects and removes the unused Debian-created `18/main` cluster;
5. disables the Debian wrapper `postgresql.service`;
6. assigns mounted paths to `postgres:postgres`;
7. installs a custom `pg_autoctl.service`.

The systemd unit runs:

```text
/usr/bin/pg_autoctl run --pgdata /pgdata/pgroot/data
```

It runs as `postgres`, restarts automatically, waits for network-online, and
sets `LimitNOFILE=65536`.

### Monitor initialization

On U07, `monitor.yml` executes `pg_autoctl create monitor` with:

- PGDATA `/pgdata/pgroot/data`;
- port 5432;
- monitor host IP;
- SCRAM-SHA-256 authentication;
- self-signed SSL;
- `ssl-mode=require`.

It then:

- enables `pg_autoctl.service`;
- waits with `pg_isready`;
- assigns the monitor registration-user password;
- adds HBA entries for U05/U06 and the exporter;
- reloads PostgreSQL;
- verifies `pg_autoctl show state`.

### Data-node initialization

For the standby only, the role first delegates `pg_autoctl show state` to U07
and waits until U05 appears.

Both data nodes build a password-bearing monitor URI as a no-log fact and run
`pg_autoctl create postgres` with SCRAM and required SSL when their pg_autoctl
configuration is absent or invalid.

Rerun detection uses the keeper configuration file together with PGDATA's
`PG_VERSION`; it does not use `pg_autoctl config check` as an existence test
because that command also fails when a valid PostgreSQL instance is merely
stopped. If an older run preserved a valid keeper configuration and left a
replacement with `group = -1`, the newest preserved configuration is restored
before the service is started. Incomplete standby creation (keeper config
present but no `PG_VERSION`) still re-enters `pg_autoctl create` so the base
backup can resume.

The separate vaulted `pg_auto_failover_replication_password` is assigned to
the `pgautofailover_replicator` PostgreSQL role on the primary before standby
bootstrap. The initial standby creation receives it through the task
environment as `PGPASSWORD`, allowing `pg_basebackup` to authenticate without
placing the secret in command arguments or logs. The role then persists
`replication.password` in each keeper configuration so either node can rejoin
as a standby after a failover. A standby-only rerun delegates the primary-role
password task to the current initial primary before retrying creation. Both
the normal primary path and delegated recovery path probe `pg_isready`, start
`pg_autoctl.service` only when PostgreSQL is unavailable, and wait for the
local socket before using the PostgreSQL user module.

After initialization, the role:

1. stops PostgreSQL if necessary;
2. copies initialized `pg_wal` contents to `/pgdata/wal`;
3. removes the original directory;
4. records `.ansible_wal_relocated`;
5. bind-mounts `/pgdata/wal` at `/pgdata/pgroot/data/pg_wal`;
6. renders workload settings;
7. inserts application, health-check, and exporter HBA entries;
8. starts pg_autoctl;
9. polls the monitor until the node appears.

### Workload configuration

`postgresql-ha.conf.j2` controls:

- listen address and port;
- memory variables;
- maximum connections;
- logging into `/pgdata/log`;
- SSL and SCRAM;
- hot standby;
- synchronous commit.

It is included from the pg_autoctl-created `postgresql.conf`, preserving
pg_auto_failover ownership of the base configuration.

## 8.6 `pgbouncer`

Target: routing nodes.

### Service account and TLS

The role installs PgBouncer and creates a dedicated `pgbouncer` system user. It
creates runtime/log directories and a systemd override with:

- `User=pgbouncer`;
- `Group=pgbouncer`;
- `RuntimeDirectory=pgbouncer`;
- `LogsDirectory=pgbouncer`;
- `LimitNOFILE=65536`.

It generates a 3072-bit RSA key, CSR, and ten-year self-signed certificate with
VIP, node IP, and hostname SANs.

### Pool configuration

| Setting | Value |
|---|---:|
| Listen | `0.0.0.0:6432` |
| Pool mode | `transaction` |
| Maximum clients | 5000 |
| Default pool | 100 |
| Tracked prepared statements | 100 |
| Client TLS | `allow` |
| Server TLS | `require` |
| Authentication | SCRAM-SHA-256 |

Transaction mode returns a server connection to the pool after each
transaction. `max_client_conn=5000` describes client sockets, not 5,000
simultaneous PostgreSQL sessions. `default_pool_size=100` is evaluated per
database/user pool, so engineers must account for the number of distinct pools
when estimating total server connections.

### Authentication file behavior

`userlist.txt.j2` currently renders the application and exporter passwords as
quoted plaintext entries into `/etc/pgbouncer/userlist.txt`. The file is
protected as `root:pgbouncer` mode `0640`, the template task uses `no_log`, and
source values should come from Ansible Vault.

This implementation does **not** pre-hash the userlist values. PgBouncer uses
them to perform SCRAM authentication. Maintainers who require verifier-only
storage should replace plaintext values with compatible SCRAM verifiers and
test server-side authentication behavior before rollout.

## 8.7 `keepalived_haproxy`

Target: routing nodes, after PgBouncer.

### Keepalived

The role validates that the VRRP PASS token is 1–8 characters, then derives:

| Routing slot | State | Priority |
|---|---|---:|
| `primary` | MASTER | 101 |
| `standby` | BACKUP | 100 |

`keepalived.conf.j2` configures:

- unicast VRRP;
- the peer router IP;
- `virtual_router_id=51`;
- one-second advertisements;
- the configured VIP/prefix/interface;
- an HAProxy service tracking script;
- priority penalty when HAProxy is unhealthy.

The UFW role allows VRRP only from the other router to the local router IP.

### HAProxy

The role enables `net.ipv4.ip_nonlocal_bind=1`, allowing both routers to start
HAProxy even when only one owns the VIP.

HAProxy:

- binds `VIP:5432` in TCP mode;
- lists both routing-node PgBouncer endpoints on port 6432;
- runs an external check every three seconds;
- marks down after two failures and up after two successes;
- closes sessions when a backend is marked down;
- exposes a local runtime socket;
- binds an HTTP stats listener on 8404.

### Primary health check

`check-pg-primary.sh.j2` receives the HAProxy backend address, maps it to the
paired database, connects using the restricted `haproxy_check` login, and
requires:

```text
pg_is_in_recovery() = false
```

The password is stored in `/etc/haproxy/pg-primary-check.env`, mode `0640`,
group `haproxy`. The template task uses `no_log`.

HAProxy configuration is validated with `haproxy -c` before replacement.
HAProxy is started before Keepalived.

## 8.8 `backup_wal`

Target: database and monitor hosts with `serial: 1`.

### Database principals

On the initial primary, the role:

- creates `qms_app`;
- creates the `qms` database owned by `qms_app`;
- creates `haproxy_check`;
- creates `postgres_exporter`;
- grants `pg_monitor` to the exporter.

On the monitor database, it creates the exporter and grants `pg_monitor`.
Physical replication carries primary-side roles/database to the standby.

### WAL transport

On U05/U06:

1. creates `/var/lib/postgresql/.ssh`;
2. generates a dedicated Ed25519 archive key;
3. reads the public key;
4. delegates authorization to U07;
5. scans and pins U07's SSH host key;
6. installs `/usr/local/sbin/archive-wal`.

The archive script:

- exits successfully when the final segment already exists;
- rsyncs to `<segment>.partial`;
- atomically renames the remote file;
- optionally invokes the Rubrik hook.

`postgresql-archive.conf.j2` sets:

```text
wal_level = replica
archive_mode = on
archive_command = '/usr/local/sbin/archive-wal "%p" "%f"'
archive_timeout = '300s'
```

U07 owns `/pgdata/WalArchive` as `postgres:postgres`, mode `0750`.

### Rubrik

`rubrik_rbs_enabled` defaults to false. The installed
`/usr/local/sbin/rubrik-rbs-wal-hook` exits successfully until enabled.
`rubrik_rbs_hook_command` is the integration command placeholder.

The hook is not a replacement for a tested backup/restore design. Recovery
procedures, retention, and restore validation remain operational requirements.

## 8.9 `monitoring_agents`

Target: all nodes, with conditional exporters.

| Scope | Package/service | Port |
|---|---|---:|
| All nodes | `prometheus-node-exporter` | 9100 |
| DB cluster | `prometheus-postgres-exporter` | 9187 |
| Routing | `prometheus-pgbouncer-exporter` | 9127 |

### PostgreSQL exporter

The environment template constructs a required-SSL local connection to the
`postgres` database with URL-encoded credentials. `ARGS` binds on port 9187.

### PgBouncer exporter

Ubuntu 24.04 supplies the Python exporter. The role renders its native
configuration file, supplies `PGPASSWORD` through a protected environment file,
and overrides systemd to run as the unprivileged `prometheus` user.

### Logstash

When `configure_logstash_forwarding=true`, the role renders an rsyslog TCP
forwarding action with a persistent linked-list queue. When false, it removes
the managed file. The rsyslog handler restarts only after a change.

Firewall management is intentionally absent from this role. `ufw_firewall` is
the single owner of inbound rules.

## 9. Generated configuration inventory

| Target path | Owning role |
|---|---|
| `/etc/chrony/chrony.conf` | `os_tuning` |
| `/etc/sysctl.conf` managed keys | `os_tuning` |
| `/etc/security/limits.conf` managed blocks | `os_tuning` |
| `/etc/systemd/system/pg_autoctl.service` | `pg_auto_failover` |
| `/pgdata/pgroot/data/postgresql-ha.conf` | `pg_auto_failover` |
| `/pgdata/pgroot/data/postgresql-archive.conf` | `backup_wal` |
| `/usr/local/sbin/archive-wal` | `backup_wal` |
| `/usr/local/sbin/rubrik-rbs-wal-hook` | `backup_wal` |
| `/etc/pgbouncer/pgbouncer.ini` | `pgbouncer` |
| `/etc/pgbouncer/userlist.txt` | `pgbouncer` |
| `/etc/pgbouncer/pgbouncer.key/.crt` | `pgbouncer` |
| `/etc/haproxy/haproxy.cfg` | `keepalived_haproxy` |
| `/etc/haproxy/pg-primary-check.env` | `keepalived_haproxy` |
| `/usr/local/sbin/check-pg-primary` | `keepalived_haproxy` |
| `/etc/keepalived/keepalived.conf` | `keepalived_haproxy` |
| `/etc/default/prometheus-postgres-exporter` | `monitoring_agents` |
| `/etc/prometheus-pgbouncer-exporter.conf` | `monitoring_agents` |
| `/etc/default/prometheus-pgbouncer-exporter` | `monitoring_agents` |
| `/etc/rsyslog.d/60-logstash-forwarding.conf` | `monitoring_agents` |

## 10. Service ownership

| Service | Owner | Restart trigger |
|---|---|---|
| `chrony` | `os_tuning` | Chrony template change |
| `pg_autoctl` | `pg_auto_failover`, `backup_wal` | systemd/PostgreSQL/archive config change |
| `pgbouncer` | `pgbouncer` | pool config, userlist, TLS, systemd override |
| `haproxy` | `keepalived_haproxy` | HAProxy config/check credential/script |
| `keepalived` | `keepalived_haproxy` | Keepalived config/tracking script |
| node exporter | `monitoring_agents` | package/service state |
| PostgreSQL exporter | `monitoring_agents` | environment change |
| PgBouncer exporter | `monitoring_agents` | config/password/systemd change |
| `rsyslog` | `monitoring_agents` | Logstash forwarding state |

## 11. Idempotency and safe re-execution

The repository uses several idempotency mechanisms:

- package modules declare `state: present`;
- file/template modules compare content before reporting changes;
- handlers restart services only when notified;
- partition, VG, LV, filesystem, and mount modules converge on declared state;
- LV shrinking is disabled;
- PostgreSQL creation commands use `creates: PG_VERSION`;
- WAL relocation uses `.ansible_wal_relocated`;
- bind mounts use persistent mount state;
- database and role modules converge on object state;
- pg_autoctl polling observes monitor state instead of assuming timing;
- HAProxy validates configuration before installation;
- sensitive output uses `no_log`.

### 11.1 Intentional exceptions

UFW reset is intentionally not change-minimal. With
`ufw_reset_rules: true`, every full run removes undeclared rules and rebuilds
the matrix.

The first storage run is destructive to the named target disks. Idempotency
protects the declared resulting state, not pre-existing unrelated data.

`creates: PG_VERSION` prevents automatic recovery from every possible partial
pg_autoctl initialization. If creation fails after `PG_VERSION` appears but
before monitor registration completes, an engineer must diagnose state before
deciding whether to resume or rebuild.

### 11.2 Downtime considerations

- UFW is briefly reset/re-enabled during the preparation play.
- Changed PostgreSQL configuration may restart `pg_autoctl`.
- `backup_wal` uses `serial: 1`, reducing simultaneous database restarts.
- routing role handlers may restart PgBouncer, HAProxy, or Keepalived.
- a full re-run should be scheduled under change control in Production.

## 12. Security design and known boundaries

Implemented controls:

- passwordless sudo is assumed only for the dedicated `ansible` user;
- SSH key files use strict modes;
- database authentication uses SCRAM-SHA-256;
- PostgreSQL and PgBouncer server traffic requires TLS;
- sensitive Ansible tasks suppress output;
- service accounts are separated;
- exporter/health users are dedicated;
- UFW uses default-deny and source-scoped rules;
- VRRP is peer-restricted;
- HAProxy only enables a verified primary path;
- WAL transfer uses a dedicated key and pinned host key.

Boundaries requiring operational treatment:

- generated PostgreSQL/PgBouncer certificates are self-signed;
- `sslmode=require` encrypts but does not verify an enterprise CA identity;
- PgBouncer userlist currently contains protected plaintext passwords;
- `host_key_checking=False` weakens Ansible SSH identity validation;
- WAL archive authorization gives the database hosts SSH access as `postgres`
  on U07;
- Keepalived PASS is limited by VRRP to eight characters;
- UFW SSH defaults to `any` until operators restrict it;
- secret safety depends on actual Vault use and repository hygiene.

Before Production, integrate enterprise PKI, restrict SSH sources, validate
Vault processes, and review WAL SSH authorization against security policy.

## 13. Maintenance extension points

Preferred extension patterns:

- add environment differences under the matching `group_vars` group;
- add secrets under encrypted environment subdirectories;
- add firewall exceptions only to `ufw_firewall`;
- add PostgreSQL tuning to `postgresql-ha.conf.j2`;
- add archive behavior through the Rubrik hook interface;
- add new exporter configuration under `monitoring_agents`;
- preserve monitor → primary → standby play order;
- preserve HAProxy-before-Keepalived startup.

When adding a new role:

1. define its host scope;
2. document ports and update UFW;
3. place environment-independent defaults in `all.yml`;
4. place addresses/CIDRs in environment variables;
5. protect secrets with Vault and `no_log`;
6. add validation assertions;
7. add handlers only for real change events;
8. update both documentation deliverables.
