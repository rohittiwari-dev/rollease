// ============================================================================
// Rollease SDK — Flag Evaluation Engine
// Pure function. No side effects. No DB calls.
// Implements the 9-step evaluation pipeline.
// ============================================================================

import { getBucket } from "../bucket";
import { safeRegexTest } from "../core/security";
import type {
  Flag,
  FlagRule,
  FlagContext,
  FlagResult,
  FlagConditionGroup,
  FlagConditionLeaf,
  Segment,
  RolloutConfig,
  EvalReason,
  ExclusionLayer,
  EvaluationTraceStep,
} from "../core/types";

// ── Semver Utilities ───────────────────────────────────────────────────────

function parseSemver(v: string): number[] {
  const clean = v.replace(/^v/, "").split("-")[0];
  const parts = clean.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function semverCompare(v1: string, v2: string): number | null {
  try {
    const p1 = parseSemver(v1);
    const p2 = parseSemver(v2);
    for (let i = 0; i < 3; i++) {
      if (Number.isNaN(p1[i]) || Number.isNaN(p2[i])) return null;
      if (p1[i] > p2[i]) return 1;
      if (p1[i] < p2[i]) return -1;
    }
    return 0;
  } catch {
    return null;
  }
}

// ── Condition Evaluation ───────────────────────────────────────────────────

/**
 * Resolves the actual value from context for a given dimension.
 */
function resolveDimension(
  dimension: string,
  context: FlagContext
): unknown {
  switch (dimension) {
    case "environment":
      return context.environment;
    case "userId":
      return context.userId;
    case "userType":
      return context.userType;
    case "region":
      return context.region;
    case "version":
      return context.version;
    case "segment":
      return context.segments;
    case "ip":
      return context.ip;
    case "tenantId":
      return context.tenantId;
    case "device":
      return context.attributes?.device;
    case "channel":
      return context.attributes?.channel;
    case "attribute":
      // For attribute conditions, the value contains { key, match }
      // Resolution is handled in evaluateConditionLeaf
      return undefined;
    default:
      // Check attributes as fallback
      return context.attributes?.[dimension];
  }
}

/**
 * Evaluates a single condition leaf against the context.
 */
function evaluateConditionLeaf(
  leaf: FlagConditionLeaf,
  context: FlagContext
): boolean {
  let actual: unknown;

  // Special handling for "attribute" dimension — value is { key, match }
  if (leaf.dimension === "attribute" && typeof leaf.value === "object" && leaf.value !== null) {
    const attrSpec = leaf.value as { key: string; match: unknown };
    actual = context.attributes?.[attrSpec.key];
    return evaluateOperator(leaf.op, actual, attrSpec.match);
  }

  // Special handling for "segment" dimension
  if (leaf.dimension === "segment") {
    const userSegments = context.segments || [];
    return evaluateOperator(leaf.op, userSegments, leaf.value);
  }

  actual = resolveDimension(leaf.dimension, context);
  return evaluateOperator(leaf.op, actual, leaf.value);
}

/**
 * Applies an operator to compare actual vs expected values.
 */
function evaluateOperator(op: string, actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) {
    if (op === "exists") return !expected;
    if (op === "neq" || op === "nin") return true;
    return false;
  }

  switch (op) {
    case "eq":
      return actual === expected;

    case "neq":
      return actual !== expected;

    case "in":
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          // Check if any actual value is in expected
          return actual.some((v) => expected.includes(v));
        }
        return expected.includes(actual);
      }
      // When expected is a string and actual is an array (e.g. segment matching)
      if (Array.isArray(actual) && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (typeof expected === "string") {
        return actual === expected;
      }
      return false;

    case "nin":
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          return !actual.some((v) => expected.includes(v));
        }
        return !expected.includes(actual);
      }
      return true;

    case "gt":
      return Number(actual) > Number(expected);

    case "gte":
      return Number(actual) >= Number(expected);

    case "lt":
      return Number(actual) < Number(expected);

    case "lte":
      return Number(actual) <= Number(expected);

    case "contains":
      return typeof actual === "string" && actual.includes(String(expected));

    case "startsWith":
      return typeof actual === "string" && actual.startsWith(String(expected));

    case "endsWith":
      return typeof actual === "string" && actual.endsWith(String(expected));

    case "regex":
      return safeRegexTest(expected, actual);

    case "semverGte": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      const cmpGte = semverCompare(actual, expected);
      return cmpGte !== null && cmpGte >= 0;
    }

    case "semverLte": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      const cmpLte = semverCompare(actual, expected);
      return cmpLte !== null && cmpLte <= 0;
    }

    case "exists":
      return expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;

    case "dateAfter": {
      const aAfter = new Date(String(actual)).getTime();
      const bAfter = new Date(String(expected)).getTime();
      return !isNaN(aAfter) && !isNaN(bAfter) && aAfter > bAfter;
    }

    case "dateBefore": {
      const aBefore = new Date(String(actual)).getTime();
      const bBefore = new Date(String(expected)).getTime();
      return !isNaN(aBefore) && !isNaN(bBefore) && aBefore < bBefore;
    }

    default:
      return false;
  }
}

/**
 * Evaluates a condition group (AND/OR/NOT) recursively.
 */
function evaluateConditionGroup(
  group: FlagConditionGroup,
  context: FlagContext
): boolean {
  // ALL — every condition must match (AND)
  if (group.all && group.all.length > 0) {
    const allMatch = group.all.every((cond) => {
      if ("dimension" in cond) {
        return evaluateConditionLeaf(cond, context);
      }
      return evaluateConditionGroup(cond, context);
    });
    if (!allMatch) return false;
  }

  // ANY — at least one must match (OR)
  if (group.any && group.any.length > 0) {
    const anyMatch = group.any.some((cond) => {
      if ("dimension" in cond) {
        return evaluateConditionLeaf(cond, context);
      }
      return evaluateConditionGroup(cond, context);
    });
    if (!anyMatch) return false;
  }

  // NONE — none must match (NOT)
  if (group.none && group.none.length > 0) {
    const noneMatch = group.none.every((cond) => {
      if ("dimension" in cond) {
        return !evaluateConditionLeaf(cond, context);
      }
      return !evaluateConditionGroup(cond, context);
    });
    if (!noneMatch) return false;
  }

  return true;
}

// ── Rule Evaluation ────────────────────────────────────────────────────────

/**
 * Evaluates whether a targeting rule matches the given context.
 */
function evaluateRule(rule: FlagRule, context: FlagContext, flagKey: string): boolean {
  // Rule disabled → skip
  if (!rule.enabled) return false;

  // User-list targeting — if userIds is set, only these users can match
  if (rule.userIds && rule.userIds.length > 0) {
    if (!context.userId || !rule.userIds.includes(context.userId)) {
      return false;
    }
  }

  // Evaluate conditions
  if (!evaluateConditionGroup(rule.conditions, context)) {
    return false;
  }

  // Per-rule rollout percentage
  if (rule.rolloutPct !== undefined && rule.rolloutPct !== null && context.userId) {
    const bucket = getBucket(context.userId, flagKey, rule.id);
    if (bucket >= rule.rolloutPct) {
      return false;
    }
  }

  return true;
}

// ── Rollout Resolution ─────────────────────────────────────────────────────

/**
 * Resolves the current effective rollout percentage, taking ramp schedule into account.
 */
function resolveRolloutPercentage(rollout: RolloutConfig, now: Date = new Date()): number {
  if (!rollout.rampSchedule || rollout.rampSchedule.length === 0) {
    return rollout.percentage;
  }

  // Sort schedule by date ascending
  const sorted = [...rollout.rampSchedule].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  );

  // Find the most recent step that has passed
  let effectivePct = rollout.percentage;
  for (const step of sorted) {
    if (new Date(step.at).getTime() <= now.getTime()) {
      effectivePct = step.percentage;
    } else {
      break;
    }
  }

  return effectivePct;
}

// ── Main Evaluation Function ───────────────────────────────────────────────

export interface EvaluateOptions {
  /** Rules for this flag (from DB) */
  rules?: FlagRule[];
  /** Sticky variant assignment for this user */
  userAssignment?: string;
  /** Developer local override value */
  localOverride?: unknown;
  /** Segments for resolving segment conditions */
  segments?: Segment[];
  /** Current date (for testing date-based logic) */
  now?: Date;
  /**
   * Pre-evaluated prerequisite flag results. Keyed by flagKey.
   * Used by FlagManager to pass resolved prerequisites to the evaluator.
   */
  prerequisiteResults?: Record<string, FlagResult>;
  /**
   * Optional exclusion layer details for the layer this flag belongs to.
   */
  exclusionLayer?: ExclusionLayer;
  /**
   * Optional logger callback for evaluator warnings (e.g. a rule pointing at
   * a deleted variant). Keeps the evaluator pure — it never touches console
   * directly so it stays safe in Edge runtimes and tests.
   */
  onWarning?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * When true, the returned FlagResult includes a `trace` field describing
   * every pipeline step that was evaluated (matched or bypassed).
   */
  trace?: boolean;
}

/**
 * Pure evaluation function — the heart of the Rollease SDK.
 *
 * Implements the 9-step pipeline:
 * 1. Flag exists?
 * 2. Kill switch
 * 3. Flag disabled / archived
 * 4. Date window (scheduledAt / expiresAt)
 * 5. Local override (.rolleaserc.json)
 * 6. Sticky assignment
 * 7. Targeting rules (by priority)
 * 8. Percentage rollout
 * 9. Default value
 */
export function evaluateFlag<T = unknown>(
  flag: Flag,
  context: FlagContext,
  options: EvaluateOptions = {}
): FlagResult<T> {
  const now = options.now || new Date();
  const tracing = options.trace === true;
  const steps: EvaluationTraceStep[] = [];

  function pushStep(n: number, name: string, matched: boolean, detail?: string): void {
    if (tracing) steps.push({ step: n, name, matched, detail });
  }

  function withTrace(result: FlagResult<T>): FlagResult<T> {
    if (!tracing) return result;
    return {
      ...result,
      trace: {
        steps,
        matchedRuleId: result.ruleId ?? undefined,
        matchedVariantId: result.variant ?? undefined,
      },
    };
  }

  // ── Step 2: Kill Switch ──────────────────────────────────────────────
  if (flag.status === "killed") {
    pushStep(2, "kill_switch", true);
    return withTrace(makeResult(flag, false, null, "kill_switch", null, now));
  }
  pushStep(2, "kill_switch", false);

  // ── Step 3: Disabled / Archived ──────────────────────────────────────
  if (flag.status === "archived") {
    pushStep(3, "disabled", true);
    return withTrace(makeResult(flag, flag.defaultValue, null, "disabled", null, now));
  }
  pushStep(3, "disabled", false);

  // ── Step 4: Date Window ──────────────────────────────────────────────
  if (flag.scheduledAt) {
    const schedDate = new Date(flag.scheduledAt);
    if (schedDate.getTime() > now.getTime()) {
      pushStep(4, "date_window", true, `not_scheduled until ${flag.scheduledAt}`);
      return withTrace(makeResult(flag, flag.defaultValue, null, "not_scheduled", null, now));
    }
  }
  if (flag.expiresAt) {
    const expDate = new Date(flag.expiresAt);
    if (expDate.getTime() < now.getTime()) {
      pushStep(4, "date_window", true, `expired at ${flag.expiresAt}`);
      return withTrace(makeResult(flag, flag.defaultValue, null, "expired", null, now));
    }
  }
  pushStep(4, "date_window", false);

  // ── Step 4.5: Prerequisites ─────────────────────────────────────
  if (flag.prerequisites && flag.prerequisites.length > 0 && options.prerequisiteResults) {
    for (const prereq of flag.prerequisites) {
      const prereqResult = options.prerequisiteResults[prereq.flagKey];
      if (!prereqResult || prereqResult.value !== prereq.variation) {
        pushStep(5, "prerequisites", true, `prerequisite ${prereq.flagKey} not met`);
        return withTrace(makeResult(flag, flag.defaultValue, null, "prerequisite_not_met", null, now));
      }
    }
  }
  pushStep(5, "prerequisites", false);

  // ── Step 4.6: Exclusion Layers ──────────────────────────────────
  if (flag.exclusionLayer) {
    if (!options.exclusionLayer) {
      pushStep(6, "exclusion_layer", true, "exclusion_layer_not_found");
      return withTrace(makeResult(flag, flag.defaultValue, null, "exclusion_layer_not_found", null, now));
    }
    const userId = context.userId;
    if (!userId) {
      pushStep(6, "exclusion_layer", true, "no userId for exclusion check");
      return withTrace(makeResult(flag, flag.defaultValue, null, "exclusion_group_miss", null, now));
    }
    const bucket = getBucket(userId, options.exclusionLayer.key);
    const allocation = options.exclusionLayer.allocations.find((a) => a.flagKey === flag.key);
    if (!allocation || bucket < allocation.startBucket || bucket >= allocation.endBucket) {
      pushStep(6, "exclusion_layer", true, `bucket ${bucket} outside allocation`);
      return withTrace(makeResult(flag, flag.defaultValue, null, "exclusion_group_miss", null, now));
    }
  }
  pushStep(6, "exclusion_layer", false);

  // ── Step 5: Local Override ───────────────────────────────────────────
  if (options.localOverride !== undefined) {
    let value: unknown = options.localOverride;
    let variant: string | null = null;

    if (flag.type === "multivariate" && flag.variants) {
      const matched = flag.variants.find((v) => v.key === options.localOverride);
      if (matched) {
        value = matched.value;
        variant = matched.key;
      }
    }

    pushStep(7, "local_override", true, `override value: ${String(options.localOverride)}`);
    return withTrace(makeResult<T>(flag, value, variant, "override", null, now));
  }
  pushStep(7, "local_override", false);

  // ── Step 6: Sticky Assignment ────────────────────────────────────────
  if (options.userAssignment) {
    let value: unknown = options.userAssignment;
    let variant: string | null = null;

    if (flag.type === "multivariate" && flag.variants) {
      const matched = flag.variants.find((v) => v.key === options.userAssignment);
      if (matched) {
        value = matched.value;
        variant = matched.key;
      }
    }

    pushStep(8, "sticky_assignment", true, `assigned variant: ${options.userAssignment}`);
    return withTrace(makeResult(flag, value, variant, "assignment", null, now));
  }
  pushStep(8, "sticky_assignment", false);

  // ── Step 7: Targeting Rules ──────────────────────────────────────────
  const rules = [...(options.rules || [])].sort((a, b) => a.priority - b.priority);

  for (const rule of rules) {
    if (evaluateRule(rule, context, flag.key)) {
      // Holdout group — return default (control)
      if (rule.isHoldout) {
        pushStep(9, "targeting_rules", true, `holdout rule ${rule.id}`);
        return withTrace(makeResult(flag, flag.defaultValue, null, "rule_match", rule.id, now));
      }

      // Multivariate: resolve specific variant
      if (flag.type === "multivariate" && flag.variants && rule.variantId) {
        const variant = flag.variants.find((v) => v.id === rule.variantId);
        if (variant) {
          pushStep(9, "targeting_rules", true, `rule ${rule.id} → variant ${variant.key}`);
          return withTrace(makeResult(flag, variant.value, variant.key, "rule_match", rule.id, now));
        }
        // Warn loudly — rule points at a variant that was renamed or deleted.
        options.onWarning?.(
          "Rule references missing variantId — falling back to default value",
          { flagKey: flag.key, ruleId: rule.id, variantId: rule.variantId }
        );
        pushStep(9, "targeting_rules", true, `rule ${rule.id} variantId missing, using default`);
        return withTrace(makeResult(flag, flag.defaultValue, null, "rule_match", rule.id, now));
      }

      const ruleValue =
        flag.type === "boolean" ? (rule.value ?? true) : rule.value;

      pushStep(9, "targeting_rules", true, `rule ${rule.id} matched`);
      return withTrace(makeResult(flag, ruleValue, null, "rule_match", rule.id, now));
    }
  }
  pushStep(9, "targeting_rules", false, `${rules.length} rules checked, none matched`);

  // ── Step 8: Rollout / Multivariate Distribution ───────────────────────
  const hashField = flag.rollout?.hashKey || "userId";
  const hashValue =
    ((context as Record<string, unknown>)[hashField] as string | undefined) ??
    context.userId;

  if (flag.type === "multivariate" && flag.variants && flag.variants.length > 0) {
    if (hashValue) {
      const bucket = getBucket(hashValue, flag.key);
      const sorted = [...flag.variants].sort((a, b) => a.key.localeCompare(b.key));
      let cumWeight = 0;
      for (const v of sorted) {
        cumWeight += v.weight;
        if (bucket < cumWeight) {
          pushStep(10, "rollout", true, `weighted_random bucket ${bucket} → variant ${v.key}`);
          return withTrace(makeResult(flag, v.value, v.key, "weighted_random", null, now));
        }
      }
    }
  } else if (flag.rollout && hashValue) {
    const effectivePct = resolveRolloutPercentage(flag.rollout, now);
    const bucket = getBucket(hashValue, flag.key);
    if (bucket < effectivePct) {
      const value = flag.type === "boolean" ? true : flag.defaultValue;
      pushStep(10, "rollout", true, `percentage ${effectivePct}%, bucket ${bucket}`);
      return withTrace(makeResult(flag, value, null, "percentage", null, now));
    }
  }
  pushStep(10, "rollout", false);

  // ── Step 9: Default ────────────────────────────────────────────
  if (flag.environmentDefaults && context.environment) {
    const envDefault = flag.environmentDefaults[context.environment];
    if (envDefault !== undefined) {
      pushStep(11, "default", true, `env default for ${context.environment}`);
      return withTrace(makeResult(flag, envDefault, null, "default", null, now));
    }
  }
  pushStep(11, "default", true, "global default");
  return withTrace(makeResult(flag, flag.defaultValue, null, "default", null, now));
}

// ── Result Constructor ─────────────────────────────────────────────────────

function makeResult<T>(
  flag: Flag,
  value: unknown,
  variant: string | null,
  reason: EvalReason,
  ruleId: string | null,
  evaluatedAt: Date
): FlagResult<T> {
  const enabled =
    reason === "kill_switch" ||
    reason === "disabled" ||
    reason === "expired" ||
    reason === "not_scheduled" ||
    reason === "prerequisite_not_met" ||
    reason === "exclusion_group_miss" ||
    reason === "exclusion_layer_not_found"
      ? false
      : reason === "default"
        ? flag.type === "boolean"
          ? value === true
          : true
        : true;

  return {
    key: flag.key,
    value: value as T,
    variant,
    enabled,
    reason,
    ruleId,
    evaluatedAt,
  };
}

// ── Exports ────────────────────────────────────────────────────────────────

export { resolveRolloutPercentage, evaluateConditionGroup, evaluateConditionLeaf };
