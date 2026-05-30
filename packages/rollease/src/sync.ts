// ============================================================================
// Rollease SDK — Flag Configuration Sync
// ----------------------------------------------------------------------------
// Export, diff, and promote flag definitions across environments. Designed
// for GitOps-style flag management: snapshot to a file, diff two snapshots,
// or promote a flag from staging → production.
// ============================================================================

import type { FlagManager } from "./engine/manager";
import type {
  Flag,
  FlagRule,
  Segment,
  CreateFlagInput,
  UpdateFlagInput,
  AddRuleInput,
  AuditActor,
} from "./core/types";

// ── Snapshot Format ──────────────────────────────────────────────────────────

export interface FlagSnapshot {
  /** Format version — used to gate forward-compat parsing. */
  version: 1;
  /** When this snapshot was captured (ISO-8601). */
  capturedAt: string;
  /** Environment label this snapshot describes (informational). */
  environment?: string;
  flags: SnapshotFlag[];
  segments?: SnapshotSegment[];
}

export interface SnapshotFlag {
  key: string;
  type: Flag["type"];
  status: Flag["status"];
  defaultValue: unknown;
  description?: string;
  namespace?: string;
  tags?: string[];
  locked?: boolean;
  lockedReason?: string;
  environments?: string[];
  variants?: Flag["variants"];
  rollout?: Flag["rollout"];
  scheduledAt?: string | null;
  expiresAt?: string | null;
  prerequisites?: Flag["prerequisites"];
  environmentDefaults?: Record<string, unknown>;
  exclusionLayer?: string;
  clientVisible?: boolean;
  rules?: SnapshotRule[];
}

export interface SnapshotRule {
  name?: string;
  priority: number;
  value: unknown;
  conditions: FlagRule["conditions"];
  enabled?: boolean;
  rolloutPct?: number;
  isHoldout?: boolean;
  variantId?: string;
  userIds?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SnapshotSegment {
  key: string;
  description?: string;
  rules: Segment["rules"];
}

// ── Diff Format ──────────────────────────────────────────────────────────────

export type DiffChangeType = "added" | "removed" | "modified";

export interface FlagDiffEntry {
  key: string;
  change: DiffChangeType;
  /** Per-field deltas; populated for `modified` entries. */
  fields?: Record<string, { before: unknown; after: unknown }>;
}

export interface FlagDiff {
  added: SnapshotFlag[];
  removed: SnapshotFlag[];
  modified: FlagDiffEntry[];
  unchanged: number;
}

// ── Export ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  format?: "json" | "yaml";
  /** Limit to a specific namespace. */
  namespace?: string;
  /** Limit to flags with these tags. */
  tags?: string[];
  /** Include flag rules in the snapshot. Default: true. */
  includeRules?: boolean;
  /** Include segments in the snapshot. Default: true. */
  includeSegments?: boolean;
  /** Pretty-print output. Default: true. */
  pretty?: boolean;
}

/**
 * Capture a snapshot of every active flag (and optionally segments) for the
 * given environment. Returns the snapshot object — pair with
 * `serializeSnapshot` to get a string for disk.
 */
export async function exportFlags(
  manager: FlagManager,
  opts: ExportOptions = {}
): Promise<FlagSnapshot> {
  const includeRules = opts.includeRules ?? true;
  const includeSegments = opts.includeSegments ?? true;

  const flags: SnapshotFlag[] = [];
  let offset = 0;
  const limit = 500;
  // Stream pages so very large flag tables don't have to be loaded at once.
  while (true) {
    const page = await manager.list({
      namespace: opts.namespace,
      tags: opts.tags,
      limit,
      offset,
    });
    for (const flag of page.data) {
      const snap: SnapshotFlag = {
        key: flag.key,
        type: flag.type,
        status: flag.status,
        defaultValue: flag.defaultValue,
        description: flag.description,
        namespace: flag.namespace,
        tags: flag.tags,
        locked: flag.locked,
        lockedReason: flag.lockedReason,
        environments: flag.environments,
        variants: flag.variants,
        rollout: flag.rollout,
        scheduledAt: typeof flag.scheduledAt === "string" ? flag.scheduledAt : flag.scheduledAt?.toISOString() ?? null,
        expiresAt: typeof flag.expiresAt === "string" ? flag.expiresAt : flag.expiresAt?.toISOString() ?? null,
        prerequisites: flag.prerequisites,
        environmentDefaults: flag.environmentDefaults,
        exclusionLayer: flag.exclusionLayer,
        clientVisible: flag.clientVisible,
      };
      if (includeRules) {
        const rules = await manager.listRules(flag.key);
        snap.rules = rules.map(stripRuleId);
      }
      flags.push(snap);
    }
    if (!page.hasMore) break;
    offset += page.data.length;
  }

  const snapshot: FlagSnapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    flags,
  };

  if (includeSegments) {
    const segments = await manager.listSegments();
    snapshot.segments = segments.map((s) => ({
      key: s.key,
      description: s.description,
      rules: s.rules,
    }));
  }

  return snapshot;
}

/** Serialize a snapshot to JSON or YAML. */
export function serializeSnapshot(
  snapshot: FlagSnapshot,
  format: "json" | "yaml" = "json",
  pretty = true
): string {
  if (format === "yaml") {
    return toYAML(snapshot);
  }
  return pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot);
}

/** Parse a serialized snapshot. Accepts JSON or YAML (auto-detected). */
export function parseSnapshot(raw: string): FlagSnapshot {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(raw) as FlagSnapshot;
  }
  return fromYAML(raw) as FlagSnapshot;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Produce a structural diff between two snapshots. The diff lists flags added
 * in `next`, flags removed from `prev`, and per-field deltas for modified
 * flags. Useful for code-review style flag PRs.
 */
export function diffFlags(prev: FlagSnapshot, next: FlagSnapshot): FlagDiff {
  const prevByKey = new Map(prev.flags.map((f) => [f.key, f]));
  const nextByKey = new Map(next.flags.map((f) => [f.key, f]));

  const added: SnapshotFlag[] = [];
  const removed: SnapshotFlag[] = [];
  const modified: FlagDiffEntry[] = [];
  let unchanged = 0;

  for (const [key, nextFlag] of nextByKey) {
    const prevFlag = prevByKey.get(key);
    if (!prevFlag) {
      added.push(nextFlag);
      continue;
    }
    const fields = diffFields(prevFlag, nextFlag);
    if (Object.keys(fields).length === 0) {
      unchanged++;
    } else {
      modified.push({ key, change: "modified", fields });
    }
  }
  for (const [key, prevFlag] of prevByKey) {
    if (!nextByKey.has(key)) {
      removed.push(prevFlag);
    }
  }

  return { added, removed, modified, unchanged };
}

function diffFields(
  a: SnapshotFlag,
  b: SnapshotFlag
): Record<string, { before: unknown; after: unknown }> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of keys) {
    const av = (a as unknown as Record<string, unknown>)[k];
    const bv = (b as unknown as Record<string, unknown>)[k];
    if (!deepEqual(av, bv)) {
      out[k] = { before: av, after: bv };
    }
  }
  return out;
}

// ── Promote ──────────────────────────────────────────────────────────────────

export interface PromoteOptions {
  /** Source snapshot (e.g. captured from staging). */
  source: FlagSnapshot;
  /** Limit promotion to these flag keys. Promotes all when omitted. */
  keys?: string[];
  /**
   * Dry-run: compute the plan without applying it. Defaults to false.
   * Returns the same shape as a live promote — apply later by calling
   * `applyPromotionPlan(manager, plan)`.
   */
  dryRun?: boolean;
  /** Actor for audit history. */
  actor?: AuditActor;
  /** Bail out on the first error. Defaults to false (collect + continue). */
  failFast?: boolean;
  /** Whether to also create/update rules on promoted flags. Default: true. */
  includeRules?: boolean;
}

export interface PromotionPlanItem {
  key: string;
  action: "create" | "update" | "skip";
  reason?: string;
}

export interface PromotionResult {
  plan: PromotionPlanItem[];
  applied: number;
  errors: Array<{ key: string; error: string }>;
}

/**
 * Promote a flag (or set of flags) from a source snapshot into a live
 * manager. The promoted flag's identity (key) is preserved; ownership
 * fields like createdAt are not touched.
 *
 * Use this to ship a staging flag config to production after review:
 *   const staging = await exportFlags(stagingRl)
 *   await promoteEnvironment(prodRl, { source: staging, keys: ['checkout_v2'] })
 */
export async function promoteEnvironment(
  manager: FlagManager,
  opts: PromoteOptions
): Promise<PromotionResult> {
  const includeRules = opts.includeRules ?? true;
  const wantedKeys = opts.keys ? new Set(opts.keys) : null;
  const plan: PromotionPlanItem[] = [];
  const errors: Array<{ key: string; error: string }> = [];
  let applied = 0;

  for (const snap of opts.source.flags) {
    if (wantedKeys && !wantedKeys.has(snap.key)) continue;
    // Use exact-key lookup. `manager.list({ search })` is a substring filter
    // that could return a different flag (e.g. searching "checkout" matches
    // "checkout_v2"), leading to spurious "create" plans for flags that
    // already exist.
    const existing = await manager.get(snap.key).catch(() => null);

    if (!existing) {
      plan.push({ key: snap.key, action: "create" });
    } else {
      plan.push({ key: snap.key, action: "update" });
    }

    if (opts.dryRun) continue;

    try {
      if (!existing) {
        const input: CreateFlagInput = {
          key: snap.key,
          type: snap.type,
          defaultValue: snap.defaultValue,
          description: snap.description,
          namespace: snap.namespace,
          tags: snap.tags,
          environments: snap.environments,
          variants: snap.variants?.map((v) => ({
            key: v.key,
            value: v.value,
            weight: v.weight,
            description: v.description,
          })),
          rollout: snap.rollout,
          scheduledAt: snap.scheduledAt,
          expiresAt: snap.expiresAt,
          prerequisites: snap.prerequisites,
          environmentDefaults: snap.environmentDefaults,
          exclusionLayer: snap.exclusionLayer,
          clientVisible: snap.clientVisible,
          actor: opts.actor,
        };
        await manager.create(input);
      } else {
        const patch: UpdateFlagInput = {
          defaultValue: snap.defaultValue,
          description: snap.description,
          tags: snap.tags,
          environments: snap.environments,
          scheduledAt: snap.scheduledAt,
          expiresAt: snap.expiresAt,
          exclusionLayer: snap.exclusionLayer,
          clientVisible: snap.clientVisible,
          actor: opts.actor,
        };
        await manager.update(snap.key, patch);
        if (snap.rollout) {
          await manager.setRollout(snap.key, snap.rollout, { actor: opts.actor });
        }
      }
      if (includeRules && snap.rules) {
        // Replace-style rules sync: remove existing, add snapshot rules.
        const current = await manager.listRules(snap.key);
        for (const rule of current) {
          await manager.removeRule(snap.key, rule.id, { actor: opts.actor });
        }
        for (const rule of snap.rules) {
          const input: AddRuleInput = {
            name: rule.name,
            priority: rule.priority,
            value: rule.value,
            conditions: rule.conditions,
            enabled: rule.enabled,
            rolloutPct: rule.rolloutPct,
            isHoldout: rule.isHoldout,
            variantId: rule.variantId,
            userIds: rule.userIds,
            description: rule.description,
            metadata: rule.metadata,
            actor: opts.actor,
          };
          await manager.addRule(snap.key, input);
        }
      }
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ key: snap.key, error: message });
      if (opts.failFast) break;
    }
  }

  return { plan, applied, errors };
}

// ── Internals ────────────────────────────────────────────────────────────────

function stripRuleId(rule: FlagRule): SnapshotRule {
  const { id: _id, flagKey: _flagKey, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } =
    rule as unknown as Record<string, unknown> & SnapshotRule;
  return rest as SnapshotRule;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

// ── Minimal YAML I/O ─────────────────────────────────────────────────────────
// Intentionally tiny — handles the subset of YAML our snapshots emit so we
// don't drag a full parser dep. Numbers, booleans, nulls, strings, arrays,
// nested objects.

function toYAML(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const inner = toYAML(item, indent + 1);
          return `${pad}- ${inner.replace(/^ {2}/, "")}`;
        }
        return `${pad}- ${toYAML(item, indent + 1)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (v && typeof v === "object") {
          if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
          if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${k}: {}`;
          return `${pad}${k}:\n${toYAML(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toYAML(v, indent + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

function yamlScalar(s: string): string {
  if (s === "" || /[:#&*!|>'"%@`,\[\]{}?\-\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// Minimal YAML reader: parses the output of `toYAML` only. Use a real YAML
// parser (e.g. `js-yaml`) for arbitrary inputs.
function fromYAML(raw: string): unknown {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  const root: { value: unknown } = { value: undefined };
  parseYAMLBlock(lines, 0, 0, root);
  return root.value;
}

function parseYAMLBlock(
  lines: string[],
  startLine: number,
  indent: number,
  out: { value: unknown }
): number {
  let i = startLine;
  let mode: "object" | "array" | null = null;
  let obj: Record<string, unknown> = {};
  let arr: unknown[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const lineIndent = line.match(/^ */)![0].length;
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Skip — handled by recursive child parse below.
      i++;
      continue;
    }
    const stripped = line.slice(indent);
    if (stripped.startsWith("- ")) {
      mode = "array";
      const itemRaw = stripped.slice(2);
      if (itemRaw.includes(": ")) {
        // inline first key of an object item
        const childLines = [" ".repeat(indent + 2) + itemRaw, ...lines.slice(i + 1)];
        const childOut: { value: unknown } = { value: undefined };
        const consumed = parseYAMLBlock(childLines, 0, indent + 2, childOut);
        arr.push(childOut.value);
        i += consumed; // consumed counts from childLines[0] which corresponds to current i
      } else {
        arr.push(parseYAMLScalar(itemRaw));
        i++;
      }
    } else {
      mode = "object";
      const sep = stripped.indexOf(":");
      const key = stripped.slice(0, sep).trim();
      const rest = stripped.slice(sep + 1).trim();
      if (rest === "") {
        const childOut: { value: unknown } = { value: undefined };
        const consumed = parseYAMLBlock(lines, i + 1, indent + 2, childOut);
        obj[key] = childOut.value;
        i = i + 1 + consumed;
      } else {
        obj[key] = parseYAMLScalar(rest);
        i++;
      }
    }
  }

  out.value = mode === "array" ? arr : obj;
  return i - startLine;
}

function parseYAMLScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "null" || t === "~" || t === "") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "[]") return [];
  if (t === "{}") return {};
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}
