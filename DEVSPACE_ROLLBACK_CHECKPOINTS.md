# DevSpace Rollback Checkpoints — AI Hub Pi

Saved: 2026-09-20

This file is the quick recovery reference for the custom DevSpace deployment on the AI Hub Pi.

**Keep this Pi deployment line separate from upstream `Waishnav/devspace`.**
Do not merge or rebase upstream as part of a rollback.

## Rollback checkpoint chart

| Rollback point | Saved ref | Commit | What it represents | DB schema |
|---|---|---|---|---|
| **Original baseline** | branch `rollback/devspace-v1.0.8-pre-main-test` | `fe712e2b6c07231d2a76503bf2a674b165850616` | Original DevSpace v1.0.8 deep-recovery checkpoint saved before the later main/beta experiments. | through v6 |
| Before lost-response recovery | tag `rollback/pre-334-recovery-20260920` | `f01e7772ddd5058ba6bcc911bab4bf1921be8c96` | Known-good live state before the issue-334 lost-response/replay-safety patch. | through v8 |
| Before MCP transport hardening | tag `rollback/pre-mcp-transport-20260920` | `cacdd2e95764f56e5bb25192c5c373abb285a689` | Lost-response side effects were replay-safe; MCP transport diagnostics had not yet been added. | through v8 |
| Before workspace write leases | tag `rollback/pre-workspace-lease-20260920` | `664c1239c550ae3bc1fcd5d333cf2f85fb44e30c` | MCP transport hardening was present; workspace writer leases had not yet been added. | through v8 |
| **⭐ IMMEDIATELY BEFORE BIG PHASE 2** | **tag `rollback/pre-durable-workspace-coordination-20260920`** | **`f4e024a05189e3e24120d48152446f240921e105`** | **Preferred rollback if the durable Phase 2 coordination work causes trouble. The first in-memory workspace writer lease is present, but durable SQLite leases/operation receipts, explicit stale takeover, generation fencing, and same-root persistent-agent discovery are not.** | **through v8** |
| Durable Phase 2 implementation | branch history | `d872b5c2ec3a69e282b057fcc414c3cc7f695cca` | Adds durable workspace coordination and durable operation replay. Introduces migration 9. | through v9 |
| Phase 2 + rollback documentation | branch `local/workspace-coordination-20260920` | `d2e9e0294bac02e938819e43a0909ce172a0631b` at time this file was created | Same Phase 2 runtime code plus rollback documentation. | through v9 |

## The rollback point to remember

If the large durable Phase 2 change needs to be removed, use:

```text
rollback/pre-durable-workspace-coordination-20260920
f4e024a05189e3e24120d48152446f240921e105
```

This is the checkpoint **immediately before durable Phase 2**.

It keeps the earlier Pi recovery work, including:

- lost-response/replay-safety work;
- MCP transport diagnostics;
- the first in-memory workspace writer lease.

It removes the Phase 2 durable coordination layer.

## Critical database warning

**Do not simply check out `f4e024a` and restart DevSpace.**

Current Phase 2 has already applied SQLite migration 9:

```text
9 — workspace-coordination-state
```

The pre-Phase-2 build at `f4e024a` only knows migrations through version 8.
It intentionally refuses to open a database containing an unknown migration.

Therefore a proper rollback from Phase 2 to `f4e024a` requires:

1. stop DevSpace;
2. make a consistent backup of the current SQLite database;
3. remove only migration 9's coordination tables and migration record;
4. check out `f4e024a`;
5. rebuild;
6. restart and verify.

## Preferred pre-Phase-2 rollback procedure

### 1. Stop DevSpace and verify the target

```bash
cd /home/ai/code/devspace-main-334-test-20260917

git status --short
git rev-parse rollback/pre-durable-workspace-coordination-20260920^{}

systemctl --user stop devspace.service
```

Expected rollback target:

```text
f4e024a05189e3e24120d48152446f240921e105
```

If the source tree is dirty, review and preserve those changes before continuing.

### 2. Back up the current DevSpace SQLite database

With DevSpace stopped:

```bash
python3 - <<'PY'
import sqlite3
from datetime import datetime

source = "/home/ai/.local/share/devspace/devspace.sqlite"
backup = source + ".before-pre-phase2-rollback-" + datetime.now().strftime("%Y%m%d-%H%M%S")

src = sqlite3.connect(source)
dst = sqlite3.connect(backup)
src.backup(dst)
dst.close()
src.close()

print(backup)
PY
```

Save the printed backup filename.

That backup is the recovery point for the exact post-Phase-2 database state.

### 3. Remove only Phase 2 database migration 9

This script refuses to proceed if it finds any unexpected migration newer than v8.

```bash
python3 - <<'PY'
import sqlite3

path = "/home/ai/.local/share/devspace/devspace.sqlite"
db = sqlite3.connect(path)

rows = db.execute(
    "select version, name from devspace_schema_migrations "
    "where version >= 9 order by version"
).fetchall()

expected = [(9, "workspace-coordination-state")]

if rows != expected:
    raise SystemExit(
        f"Refusing rollback: unexpected migrations >= 9: {rows!r}"
    )

try:
    db.execute("begin immediate")

    db.execute("drop table if exists operation_receipts")
    db.execute("drop table if exists workspace_write_leases")

    deleted = db.execute(
        "delete from devspace_schema_migrations "
        "where version = 9 "
        "and name = 'workspace-coordination-state'"
    )

    if deleted.rowcount != 1:
        raise RuntimeError(
            f"Expected to delete one migration row, deleted {deleted.rowcount}"
        )

    db.commit()
finally:
    db.close()
PY
```

This removes only Phase 2's durable coordination state:

- `workspace_write_leases`
- `operation_receipts`
- migration record `9 / workspace-coordination-state`

Migrations 1–8 and their existing DevSpace data remain intact.

### 4. Restore the pre-Phase-2 source and rebuild

```bash
cd /home/ai/code/devspace-main-334-test-20260917

git switch --detach rollback/pre-durable-workspace-coordination-20260920

export PATH=/home/ai/.local/opt/node-v24.21.0-linux-arm64/bin:$PATH
pnpm build
```

### 5. Start DevSpace and verify

```bash
systemctl --user start devspace.service

systemctl --user is-active devspace.service
curl -fsS http://127.0.0.1:7676/healthz
git rev-parse HEAD
```

Expected:

```text
service: active
health: {"ok":true,"name":"devspace"}
HEAD: f4e024a05189e3e24120d48152446f240921e105
```

After restarting the self-hosted DevSpace service, the ChatGPT connector can briefly reconnect.
A lost connector call by itself is **not** a reason to restart DevSpace again.
Check `/healthz` first.

## Returning to Phase 2 later

To restore the durable Phase 2 code:

```bash
systemctl --user stop devspace.service

cd /home/ai/code/devspace-main-334-test-20260917
git switch local/pi-opencode-provider-20260917

export PATH=/home/ai/.local/opt/node-v24.21.0-linux-arm64/bin:$PATH
pnpm build

systemctl --user start devspace.service
curl -fsS http://127.0.0.1:7676/healthz
```

The migration runner will recreate migration 9 if it is absent.

If the exact old Phase 2 lease/operation-receipt records are important, restore the
SQLite backup created before the rollback instead of allowing migration 9 to be
recreated empty.

## Deep rollback: original v1.0.8 baseline

Original checkpoint:

```text
rollback/devspace-v1.0.8-pre-main-test
fe712e2b6c07231d2a76503bf2a674b165850616
```

This is a **deep recovery/reference point**, not a normal one-step rollback.

That build understands database migrations only through v6, while the current
database is v9. Do not point v1.0.8 directly at today's database.

A rollback that far requires separately restoring or intentionally downgrading
the DevSpace state database to a v6-compatible state.

## Backup locations

The active custom Pi line and rollback refs are backed up in the user's GitHub fork:

```text
Joetooley28/devspace
```

Phase 2 documentation branch:

```text
local/workspace-coordination-20260920
```

Original baseline rollback branch:

```text
rollback/devspace-v1.0.8-pre-main-test
```

Rollback tags:

```text
rollback/pre-334-recovery-20260920
rollback/pre-mcp-transport-20260920
rollback/pre-workspace-lease-20260920
rollback/pre-durable-workspace-coordination-20260920
```

## Rule of thumb

For a problem caused specifically by the **large durable Phase 2 coordination change**:

**Rollback to `f4e024a`, not all the way to v1.0.8.**

The v1.0.8 point remains available as the older deep-recovery baseline.
