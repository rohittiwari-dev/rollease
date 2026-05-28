// ============================================================================
// Rollease SDK — Flag Import/Export Migrations
// ============================================================================
//
// Import flag configurations from other feature flag providers and export
// Rollease flags to portable formats.
//
// Supported imports:
// - LaunchDarkly JSON export
// - Statsig config export
// - Unleash feature toggle JSON
// - Generic JSON/YAML
//
// ============================================================================

import type { CreateFlagInput, FlagType, FlagRule } from "../core/types";

// ── Common Types ───────────────────────────────────────────────────────────

export interface ImportResult {
  flags: CreateFlagInput[];
  warnings: string[];
  skipped: string[];
}

// ── LaunchDarkly Importer ──────────────────────────────────────────────────

interface LDFlag {
  key: string;
  name?: string;
  description?: string;
  kind?: string;
  tags?: string[];
  variations?: Array<{ value: unknown; name?: string; description?: string }>;
  on?: boolean;
  fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation: number; weight: number }> } };
  offVariation?: number;
  targets?: Array<{ values: string[]; variation: number }>;
  rules?: Array<{
    clauses: Array<{ attribute: string; op: string; values: unknown[] }>;
    variation?: number;
    rollout?: { variations: Array<{ variation: number; weight: number }> };
  }>;
  archived?: boolean;
  temporary?: boolean;
  clientSideAvailability?: { usingMobileKey?: boolean; usingEnvironmentId?: boolean };
}

/**
 * Import flags from a LaunchDarkly JSON export.
 *
 * ```ts
 * import { importFromLaunchDarkly } from 'rollease/migrations'
 * const result = importFromLaunchDarkly(ldExport)
 * for (const flag of result.flags) {
 *   await rl.flags.create(flag)
 * }
 * ```
 */
export function importFromLaunchDarkly(
  data: { items?: LDFlag[] } | LDFlag[]
): ImportResult {
  const items = Array.isArray(data) ? data : data.items ?? [];
  const flags: CreateFlagInput[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  for (const ld of items) {
    try {
      const type = inferLDFlagType(ld);
      const defaultValue = ld.variations?.[ld.offVariation ?? 0]?.value ?? false;

      const variants = ld.variations?.map((v, i) => ({
        key: v.name ?? `variation-${i}`,
        value: v.value,
        weight: Math.floor(100 / (ld.variations?.length ?? 1)),
        description: v.description,
      }));

      const flag: CreateFlagInput = {
        key: ld.key,
        type,
        description: ld.description ?? ld.name ?? "",
        tags: ld.tags ?? [],
        defaultValue,
        variants,
        clientVisible: ld.clientSideAvailability?.usingEnvironmentId ?? false,
      };

      flags.push(flag);
    } catch (err) {
      warnings.push(`Failed to import "${ld.key}": ${(err as Error).message}`);
      skipped.push(ld.key);
    }
  }

  return { flags, warnings, skipped };
}

function inferLDFlagType(ld: LDFlag): FlagType {
  if (ld.kind === "multivariate") {
    const firstVar = ld.variations?.[0]?.value;
    if (typeof firstVar === "string") return "string";
    if (typeof firstVar === "number") return "number";
    if (typeof firstVar === "object") return "json";
    return "multivariate";
  }
  if (ld.kind === "boolean" || ld.variations?.length === 2) {
    const vals = ld.variations?.map((v) => v.value);
    if (vals?.every((v) => typeof v === "boolean")) return "boolean";
  }
  return "boolean";
}

// ── Statsig Importer ───────────────────────────────────────────────────────

interface StatsigGate {
  name: string;
  type?: string;
  salt?: string;
  enabled?: boolean;
  defaultValue?: unknown;
  rules?: Array<{
    name?: string;
    passPercentage?: number;
    conditions?: Array<{ type: string; targetValue?: unknown; operator?: string; field?: string }>;
    returnValue?: unknown;
  }>;
}

/**
 * Import flags from a Statsig config export.
 */
export function importFromStatsig(
  data: { feature_gates?: StatsigGate[] } | StatsigGate[]
): ImportResult {
  const items = Array.isArray(data) ? data : data.feature_gates ?? [];
  const flags: CreateFlagInput[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  for (const gate of items) {
    try {
      const flag: CreateFlagInput = {
        key: gate.name,
        type: "boolean",
        description: "",
        defaultValue: gate.defaultValue ?? false,
      };
      flags.push(flag);
    } catch (err) {
      warnings.push(`Failed to import "${gate.name}": ${(err as Error).message}`);
      skipped.push(gate.name);
    }
  }

  return { flags, warnings, skipped };
}

// ── Unleash Importer ───────────────────────────────────────────────────────

interface UnleashToggle {
  name: string;
  description?: string;
  type?: string;
  enabled?: boolean;
  stale?: boolean;
  strategies?: Array<{
    name: string;
    parameters?: Record<string, string>;
    constraints?: Array<{ contextName: string; operator: string; values: string[] }>;
  }>;
  variants?: Array<{ name: string; weight: number; payload?: { type: string; value: string } }>;
}

/**
 * Import flags from an Unleash feature toggle export.
 */
export function importFromUnleash(
  data: { features?: UnleashToggle[] } | UnleashToggle[]
): ImportResult {
  const items = Array.isArray(data) ? data : data.features ?? [];
  const flags: CreateFlagInput[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  for (const toggle of items) {
    try {
      const hasVariants = toggle.variants && toggle.variants.length > 0;
      const type: FlagType = hasVariants ? "multivariate" : "boolean";

      const variants = toggle.variants?.map((v) => ({
        key: v.name,
        value: v.payload?.value ?? v.name,
        weight: v.weight ?? 0,
      }));

      const flag: CreateFlagInput = {
        key: toggle.name,
        type,
        description: toggle.description ?? "",
        defaultValue: type === "boolean" ? false : variants?.[0]?.value ?? null,
        variants,
      };

      flags.push(flag);
    } catch (err) {
      warnings.push(`Failed to import "${toggle.name}": ${(err as Error).message}`);
      skipped.push(toggle.name);
    }
  }

  return { flags, warnings, skipped };
}

// ── Generic JSON Import/Export ─────────────────────────────────────────────

/**
 * Import flags from a generic JSON format.
 *
 * Accepts:
 * - Array of flag objects: `[{ key, type, defaultValue, ... }]`
 * - Object with `flags` key: `{ flags: [...] }`
 * - Key-value map: `{ "flag-key": { type, defaultValue, ... } }`
 */
export function importFromJson(data: unknown): ImportResult {
  const flags: CreateFlagInput[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  let items: unknown[];

  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === "object" && data !== null && "flags" in data) {
    items = (data as { flags: unknown[] }).flags;
  } else if (typeof data === "object" && data !== null) {
    items = Object.entries(data as Record<string, unknown>).map(
      ([key, value]) => ({
        key,
        ...(typeof value === "object" && value !== null ? value : { defaultValue: value }),
      })
    );
  } else {
    return { flags: [], warnings: ["Invalid JSON format"], skipped: [] };
  }

  for (const item of items) {
    try {
      const obj = item as Record<string, unknown>;
      const key = obj.key as string;
      if (!key) {
        warnings.push("Skipped item without 'key' field");
        continue;
      }

      flags.push({
        key,
        type: (obj.type as FlagType) ?? inferValueType(obj.defaultValue),
        description: obj.description as string,
        tags: obj.tags as string[],
        defaultValue: obj.defaultValue,
        variants: obj.variants as CreateFlagInput["variants"],
        clientVisible: obj.clientVisible as boolean,
        environments: obj.environments as string[],
      });
    } catch (err) {
      warnings.push(`Failed to import item: ${(err as Error).message}`);
    }
  }

  return { flags, warnings, skipped };
}

/**
 * Export Rollease flags to a portable JSON format.
 */
export function exportToJson(
  flags: Array<{
    key: string;
    type: FlagType;
    description?: string;
    tags?: string[];
    enabled: boolean;
    defaultValue: unknown;
    variants?: unknown[];
    clientVisible?: boolean;
    environments?: string[];
    rules?: FlagRule[];
    status?: string;
  }>
): { version: 1; exportedAt: string; flags: unknown[] } {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    flags: flags.map((f) => ({
      key: f.key,
      type: f.type,
      description: f.description ?? "",
      tags: f.tags ?? [],
      enabled: f.enabled,
      defaultValue: f.defaultValue,
      variants: f.variants ?? [],
      clientVisible: f.clientVisible ?? false,
      environments: f.environments ?? [],
      rules: f.rules ?? [],
      status: f.status ?? "active",
    })),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function inferValueType(value: unknown): FlagType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "object" && value !== null) return "json";
  return "boolean";
}
