// ============================================================================
// Rollease SDK - Security Helpers
// ============================================================================

import type { FlagConditionGroup, FlagConditionLeaf } from "./types";
import { ValidationError } from "./errors";

export const MAX_REGEX_PATTERN_LENGTH = 128;
export const MAX_REGEX_INPUT_LENGTH = 4096;
export const MAX_CONDITION_DEPTH = 12;
export const MAX_CONDITION_NODES = 100;

/**
 * Flag and segment keys that are forbidden because they would clobber
 * Object.prototype members when used as map keys downstream.
 */
export const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

const FLAG_KEY_PATTERN = /^[a-z0-9._-]+$/;

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

// ── Generic Walker ─────────────────────────────────────────────────────────

/**
 * Walks a condition group depth-first, invoking `visitor` for every leaf.
 * Returning `true` from the visitor short-circuits the walk.
 *
 * Reused by the safety check (walkConditionGroup) and by segment-usage scanning
 * so we don't string-match a serialized JSON blob (which yields false positives).
 */
export function walkConditions(
  group: FlagConditionGroup | undefined,
  visitor: (leaf: FlagConditionLeaf) => boolean | void
): boolean {
  if (!isConditionGroup(group)) return false;
  for (const key of ["all", "any", "none"] as const) {
    const children = group[key];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (isConditionLeaf(child)) {
        if (visitor(child) === true) return true;
        continue;
      }
      if (isConditionGroup(child) && walkConditions(child, visitor)) return true;
    }
  }
  return false;
}

/**
 * Returns true when the condition group references the given segment key as a
 * `{ dimension: 'segment', value: ... }` leaf. Compares segment-key strings
 * exactly (in/eq operators), unlike the prior `JSON.stringify().includes()`
 * approach which produced false positives when the key happened to appear in
 * unrelated string values.
 */
export function conditionReferencesSegment(
  group: FlagConditionGroup | undefined,
  segmentKey: string
): boolean {
  return walkConditions(group, (leaf) => {
    if (leaf.dimension !== "segment") return;
    if (typeof leaf.value === "string" && leaf.value === segmentKey) return true;
    if (Array.isArray(leaf.value) && leaf.value.includes(segmentKey)) return true;
  });
}

// ── Key Validation ─────────────────────────────────────────────────────────

/**
 * Validates a flag, segment, or namespace key. Allowed characters are
 * lowercase alphanumerics, dots, hyphens, and underscores. Forbidden names
 * (Object.prototype members, etc.) are rejected to prevent prototype-pollution
 * when keys are used as object keys downstream.
 */
export function isSafeFlagKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0) return false;
  if (FORBIDDEN_KEYS.has(key)) return false;
  return FLAG_KEY_PATTERN.test(key);
}

export function assertSafeFlagKey(
  key: unknown,
  label = "key"
): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new ValidationError(`${label} is required`, { key });
  }
  if (FORBIDDEN_KEYS.has(key)) {
    throw new ValidationError(
      `${label} "${key}" is reserved and cannot be used`,
      { key }
    );
  }
  if (!FLAG_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      `Invalid ${label} "${key}". Keys must be lowercase and can only contain letters, numbers, dots, hyphens, and underscores.`,
      { key }
    );
  }
}

// ── Override Path Validation ──────────────────────────────────────────────

/**
 * Resolves the override file path against the current working directory and
 * rejects anything that escapes it (path traversal) or points at an absolute
 * location. Returns the resolved absolute path on success.
 */
export function validateOverridePath(
  filePath: string,
  cwd: string
): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new ValidationError("Override file path must be a non-empty string", {
      filePath,
    });
  }
  // Use a tiny path-join to avoid pulling node:path at module top-level (Edge-safe).
  const resolved = resolveJoin(cwd, filePath);
  const normalizedCwd = normalizeSlashes(cwd).replace(/[\\/]+$/, "");
  const normalizedResolved = normalizeSlashes(resolved);

  if (
    normalizedResolved !== normalizedCwd &&
    !normalizedResolved.startsWith(normalizedCwd + "/")
  ) {
    throw new ValidationError(
      "Override file path must resolve inside the current working directory",
      { filePath, resolved }
    );
  }
  return resolved;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveJoin(base: string, segment: string): string {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(segment);
  const joined = isAbs ? segment : `${base}/${segment}`;
  const parts = normalizeSlashes(joined).split("/");
  const stack: string[] = [];
  let leadingSlash = false;
  let driveLetter = "";

  if (parts[0] === "" && parts.length > 1) {
    leadingSlash = true;
    parts.shift();
  } else if (/^[a-zA-Z]:$/.test(parts[0])) {
    driveLetter = parts.shift()!;
  }

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const tail = stack.join("/");
  if (driveLetter) return `${driveLetter}/${tail}`;
  return leadingSlash ? `/${tail}` : tail;
}
