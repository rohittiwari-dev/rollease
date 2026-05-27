// ============================================================================
// Rollease SDK - Security Helpers
// ============================================================================

import type { FlagConditionGroup, FlagConditionLeaf } from "./types";
import { ValidationError } from "./errors";

export const MAX_REGEX_PATTERN_LENGTH = 128;
export const MAX_REGEX_INPUT_LENGTH = 4096;
export const MAX_CONDITION_DEPTH = 12;
export const MAX_CONDITION_NODES = 100;

const BACKREFERENCE_RE = /\\(?:[1-9]\d*|k<[^>]+>)/;
const LOOKAROUND_RE = /\(\?<?[=!]/;
const NESTED_QUANTIFIER_RE =
  /\((?:\\.|[^()\\])*(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()\\])*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;
const QUANTIFIED_ALTERNATION_RE =
  /\((?:\\.|[^()\\])*\|(?:\\.|[^()\\])*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;
const RANGE_QUANTIFIER_RE = /\{(\d+)(?:,(\d*))?\}/g;

export function isSafeRegexPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string") return false;
  if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  if (BACKREFERENCE_RE.test(pattern)) return false;
  if (LOOKAROUND_RE.test(pattern)) return false;
  if (NESTED_QUANTIFIER_RE.test(pattern)) return false;
  if (QUANTIFIED_ALTERNATION_RE.test(pattern)) return false;

  RANGE_QUANTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RANGE_QUANTIFIER_RE.exec(pattern))) {
    const min = Number(match[1]);
    const max = match[2] === undefined || match[2] === "" ? min : Number(match[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    if (min > 1000 || max > 1000 || max - min > 1000) return false;
  }

  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function safeRegexTest(pattern: unknown, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  if (actual.length > MAX_REGEX_INPUT_LENGTH) return false;
  if (!isSafeRegexPattern(pattern)) return false;
  return new RegExp(pattern).test(actual);
}

export function assertSafeConditionGroup(
  group: FlagConditionGroup,
  label = "conditions"
): void {
  const issue = findUnsafeConditionIssue(group, label);
  if (issue) {
    throw new ValidationError("Unsafe flag condition rejected", { issue });
  }
}

export function findUnsafeConditionIssue(
  group: FlagConditionGroup,
  label = "conditions"
): string | null {
  if (!isConditionGroup(group)) {
    return `${label} must be an object`;
  }
  const seen = { nodes: 0 };
  return walkConditionGroup(group, label, 0, seen);
}

function walkConditionGroup(
  group: FlagConditionGroup,
  path: string,
  depth: number,
  seen: { nodes: number }
): string | null {
  if (depth > MAX_CONDITION_DEPTH) {
    return `${path} exceeds maximum nesting depth`;
  }

  seen.nodes += 1;
  if (seen.nodes > MAX_CONDITION_NODES) {
    return `${path} exceeds maximum condition count`;
  }

  for (const key of ["all", "any", "none"] as const) {
    const children = group[key];
    if (!children) continue;
    if (!Array.isArray(children)) {
      return `${path}.${key} must be an array`;
    }

    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const childPath = `${path}.${key}[${i}]`;

      if (isConditionLeaf(child)) {
        if (child.op === "regex" && !isSafeRegexPattern(child.value)) {
          return `${childPath} contains an unsafe regex pattern`;
        }
        continue;
      }

      if (!isConditionGroup(child)) {
        return `${childPath} must be a condition leaf or group`;
      }

      const issue = walkConditionGroup(child, childPath, depth + 1, seen);
      if (issue) return issue;
    }
  }

  return null;
}

function isConditionGroup(value: unknown): value is FlagConditionGroup {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConditionLeaf(
  value: unknown
): value is FlagConditionLeaf {
  return (
    typeof value === "object" &&
    value !== null &&
    "dimension" in value &&
    "op" in value
  );
}
