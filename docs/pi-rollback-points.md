# Pi DevSpace Rollback Points

This file records the known-good rollback points for the custom DevSpace deployment
running on the AI Hub Pi. Keep this deployment line separate from upstream
`Waishnav/devspace`; do not merge or rebase upstream as part of a rollback.

## Rollback map

| Point | Saved ref / commit | What it represents | DB schema |
| --- | --- | --- | --- |
| Original baseline | branch `rollback/devspace-v1.0.8-pre-main-test` → `fe712e2` | DevSpace v1.0.8 checkpoint kept before the later main/beta experiments. This is the original deep rollback/reference point documented before the current recovery work. | through v6 |
| Before lost-response recovery | `rollback/pre-334-recovery-20260920` → `f01e777` | Known-good live state before the issue-334 lost-response/replay-safety patch. | through v8 |
| Before MCP transport diagnostics | `rollback/pre-mcp-transport-20260920` → `cacdd2e` | Lost-response side effects were replay-safe; transport diagnostics had not yet been added. | through v8 |
| Before workspace writer lease | `rollback/pre-workspace-lease-20260920` → `664c123` | Transport diagnostics were present; workspace write leases had not yet been added. | through v8 |
| **Immediately before durable Phase 2** | **`rollback/pre-durable-workspace-coordination-20260920` → `f4e024a`** | **In-memory workspace write leases were present. Durable SQLite leases/operation receipts, explicit stale takeover, generation fencing, and same-root persistent-agent discovery had not yet been added. This is the preferred rollback point if the large Phase 2 coordination change causes trouble.** | **through v8** |
| Durable Phase 2 | `d872b5c` | Durable workspace coordination and durable operation replay. Migration 9 is introduced here. | through v9 |

The Phase 2 source checkpoint is also backed up on the user's fork:
`Joetooley28/devspace`, branch `local/workspace-coordination-20260920`.

## Preferred rollback: immediately before durable Phase 2

Do not only check out `f4e024a` and restart. Phase 2 applied database migration 9
(`workspace-coordination-state`), while `f4e024a` knows migrations only through
version 8. An older build intentionally refuses to start when it sees an unknown
migration.

The safe rollback therefore has two parts: restore the source/build to
`f4e024a`, and remove only migration 9's coordination state after backing up
the database.

### 1. Stop DevSpace and confirm the target

```bash
cd /home/ai/code/devspace-main-334-test-20260917
git status --short
git rev-parse rollback/pre-durable-workspace-coordination-20260920^{}
systemctl --user stop devspace.service
```

Expected target commit:

```text
f4e024a05189e3e24120d48152446f240921e105
```

Do not continue with a dirty source tree unless those changes have first been
reviewed and preserved.

### 2. Back up the current SQLite database

With the service stopped, make a consistent SQLite backup before changing the
migration history:

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

Keep the printed backup path. It is the fastest route back to the exact
post-Phase-2 state if the rollback itself needs to be reversed.

### 3. Downgrade only migration 9

This guard deliberately aborts unless version 9 is the only migration newer than
the pre-Phase-2 build expects.

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
    raise SystemExit(f"Refusing rollback: unexpected migrations >= 9: {rows!r}")

try:
    db.execute("begin immediate")
    db.execute("drop table if exists operation_receipts")
    db.execute("drop table if exists workspace_write_leases")
    deleted = db.execute(
        "delete from devspace_schema_migrations "
        "where version = 9 and name = 'workspace-coordination-state'"
    )
    if deleted.rowcount != 1:
        raise RuntimeError(f"Expected to delete one migration row, deleted {deleted.rowcount}")
    db.commit()
finally:
    db.close()
PY
```

This intentionally discards only Phase 2's durable writer-lease and operation-
receipt history. Workspace sessions, conversation bindings, persistent subagent
sessions/turns, OAuth state, and migrations 1-8 remain intact.

### 4. Restore and build the pre-Phase-2 source

```bash
git switch --detach rollback/pre-durable-workspace-coordination-20260920

export PATH=/home/ai/.local/opt/node-v24.21.0-linux-arm64/bin:$PATH
pnpm build
```

### 5. Start and verify

```bash
systemctl --user start devspace.service
systemctl --user is-active devspace.service
curl -fsS http://127.0.0.1:7676/healthz
git rev-parse HEAD
```

Expected Git commit is `f4e024a05189e3e24120d48152446f240921e105`,
the service should report `active`, and `/healthz` should return
`{"ok":true,"name":"devspace"}`.

After a self-hosted DevSpace restart, the ChatGPT connector may need a brief
reconnect before MCP calls resume. Do not restart DevSpace again merely because
the first connector call is lost; first verify `/healthz`.

## Returning to durable Phase 2

If the pre-Phase-2 rollback is healthy but Phase 2 should be restored later,
switch back to the deployment branch, rebuild, and start DevSpace. The normal
migration runner will recreate migration 9.

```bash
systemctl --user stop devspace.service
cd /home/ai/code/devspace-main-334-test-20260917
git switch local/pi-opencode-provider-20260917

export PATH=/home/ai/.local/opt/node-v24.21.0-linux-arm64/bin:$PATH
pnpm build
systemctl --user start devspace.service
curl -fsS http://127.0.0.1:7676/healthz
```

If an exact restoration of the old Phase 2 lease/receipt records matters, restore
the SQLite backup made before the rollback instead of allowing migration 9 to be
recreated empty.

## Earlier rollback points

The three intermediate rollback tags (`f01e777`, `cacdd2e`, and `664c123`) also
understand database migrations through v8. Rolling back from the current Phase 2
database to any of them therefore requires the same migration-9 backup/downgrade
step above.

The v1.0.8 baseline at `fe712e2` understands only migrations through v6. Treat
it as a deep recovery/reference point, not a normal one-step live rollback.
Returning that far requires separately restoring or intentionally downgrading
the DevSpace state database to a schema compatible with v1.0.8. Do not point the
v1.0.8 build at the current v9 database.

## Rule of thumb

For a problem specifically caused by the large durable coordination Phase 2
change, use **`f4e024a`**. It preserves all of the immediately preceding Pi
work, including the lost-response recovery patch, transport diagnostics, and the
first in-memory workspace writer lease, while removing the new durable
coordination layer.
