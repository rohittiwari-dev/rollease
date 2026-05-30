# Rollease SDK — Configuration Sync

> **Module:** `rollease/sync`
> **Purpose:** Snapshot flag configuration to disk, diff two snapshots, promote flags between environments.

Designed for GitOps-style flag management — treat flag config as code that you can review, diff, and promote.

---

## API surface

```ts
import {
  exportFlags,
  serializeSnapshot,
  parseSnapshot,
  diffFlags,
  promoteEnvironment,
} from "rollease/sync";
```

---

## Export a snapshot

Capture every active flag (and optionally segments) to a `FlagSnapshot` object.

```ts
import { exportFlags, serializeSnapshot } from "rollease/sync";
import { writeFileSync } from "node:fs";

const snapshot = await exportFlags(rl.flags, {
  namespace: "checkout",       // optional — limit to one namespace
  tags: ["pricing"],           // optional — limit to tagged flags
  includeRules: true,          // default true
  includeSegments: true,       // default true
});

writeFileSync(
  "flags-prod.json",
  serializeSnapshot(snapshot, "json")
);

// Or YAML:
writeFileSync(
  "flags-prod.yaml",
  serializeSnapshot(snapshot, "yaml")
);
```

### Snapshot shape

```ts
interface FlagSnapshot {
  version: 1;
  capturedAt: string;          // ISO timestamp
  environment?: string;
  flags: SnapshotFlag[];       // every flag with embedded rules
  segments?: SnapshotSegment[];
}
```

---

## Diff two snapshots

Find what changed between two snapshots (e.g. staging vs production) before approving a promotion.

```ts
import { parseSnapshot, diffFlags } from "rollease/sync";
import { readFileSync } from "node:fs";

const staging = parseSnapshot(readFileSync("flags-staging.json", "utf8"));
const prod    = parseSnapshot(readFileSync("flags-prod.json", "utf8"));

const diff = diffFlags(prod, staging);

console.log(`+${diff.added.length} added`);
console.log(`-${diff.removed.length} removed`);
console.log(`~${diff.modified.length} modified`);
console.log(`=${diff.unchanged} unchanged`);

for (const entry of diff.modified) {
  console.log(`\n${entry.key}:`);
  for (const [field, { before, after }] of Object.entries(entry.fields!)) {
    console.log(`  ${field}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
}
```

### CI integration — fail PR if production-bound diff is unreviewed

```yaml
# .github/workflows/flag-diff.yml
on: pull_request
jobs:
  flag-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bun install
      - run: bun run scripts/flag-diff.ts --base main --head HEAD > diff.md
      - uses: actions/github-script@v7
        with:
          script: |
            const fs = require("fs");
            const body = fs.readFileSync("diff.md", "utf8");
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: "## Flag diff\n\n" + body,
            });
```

---

## Promote between environments

Apply a source snapshot to a target manager. Rules are **replace-synced** — existing rules are removed and snapshot rules added — so the target ends in the source's exact state.

```ts
import { exportFlags, promoteEnvironment } from "rollease/sync";

// Capture staging
const staging = await exportFlags(stagingRl.flags);

// Promote a subset to production
const result = await promoteEnvironment(prodRl.flags, {
  source: staging,
  keys: ["checkout_v2", "pricing_tier_b"],     // optional — promote a subset
  actor: { id: "ops-bot", type: "service" },
  includeRules: true,                          // default true
  failFast: false,                             // default — collect errors
});

result.plan       // [{ key: "checkout_v2", action: "update" }, ...]
result.applied    // number applied
result.errors     // [{ key, error }, ...] — collected when failFast is false
```

### Dry-run first

```ts
const plan = await promoteEnvironment(prodRl.flags, {
  source: staging,
  keys: ["checkout_v2"],
  dryRun: true,
});

console.log(plan.plan);
// [{ key: "checkout_v2", action: "update" }]

// User confirms, then:
await promoteEnvironment(prodRl.flags, {
  source: staging,
  keys: ["checkout_v2"],
  actor: { id: requestingUserId, type: "user" },
});
```

---

## YAML notes

The built-in YAML reader handles the subset that `serializeSnapshot(snap, "yaml")` emits — round-tripping is safe. For arbitrary YAML (snapshots edited by hand with anchors, multi-line strings, etc.), use a real parser:

```ts
import yaml from "js-yaml";
import type { FlagSnapshot } from "rollease/sync";

const snapshot = yaml.load(text) as FlagSnapshot;
// Then call diffFlags / promoteEnvironment as normal.
```

---

## Patterns

### Daily backup

```ts
import { exportFlags, serializeSnapshot } from "rollease/sync";

// In a cron handler:
const snapshot = await exportFlags(rl.flags);
await s3.putObject({
  Bucket: "flag-backups",
  Key: `${new Date().toISOString().slice(0, 10)}.json`,
  Body: serializeSnapshot(snapshot, "json"),
});
```

### Restore from snapshot

```ts
import { parseSnapshot, promoteEnvironment } from "rollease/sync";

const text = await s3.getObject({ Bucket: "flag-backups", Key: "2026-05-15.json" });
const snapshot = parseSnapshot(text);

await promoteEnvironment(rl.flags, {
  source: snapshot,
  actor: { id: "restore", type: "system" },
});
```

### Environment-to-environment sync (live)

```ts
// Mirror staging → preview-env every 5 minutes.
setInterval(async () => {
  const snap = await exportFlags(stagingRl.flags);
  await promoteEnvironment(previewRl.flags, {
    source: snap,
    actor: { id: "preview-sync", type: "service" },
  });
}, 5 * 60 * 1000);
```

---

## Limitations (current)

- `status` (`active` / `killed` / `archived`) is **not** synced — promote only touches definition and rules. Use the kill switch separately.
- `locked` state is not synced; locks must be set explicitly per environment via `setLock`.
- Rules are replace-synced — any manually-added rule on the target that's not in the source is removed. Pick `includeRules: false` if you only want to sync flag definitions.
