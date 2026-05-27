// ============================================================================
// Rollease SDK — Error Classes
// ============================================================================

/**
 * Base error class for all Rollease errors.
 * Provides consistent shape: statusCode, code, message, meta.
 */
export class RolleaseError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly meta: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    meta: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RolleaseError";
    this.statusCode = statusCode;
    this.code = code;
    this.meta = meta;

    // Ensure instanceof checks work in TypeScript
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      error: this.name,
      statusCode: this.statusCode,
      code: this.code,
      message: this.message,
      meta: this.meta,
    };
  }
}

/**
 * Thrown when a flag key is not found.
 * Note: `isEnabled()` returns false for missing flags — only management operations throw.
 */
export class FlagNotFoundError extends RolleaseError {
  constructor(flagKey: string) {
    super(
      `Flag "${flagKey}" not found`,
      404,
      "FLAG_NOT_FOUND",
      { flagKey }
    );
    this.name = "FlagNotFoundError";
  }
}

/**
 * Thrown when trying to modify a locked flag.
 */
export class FlagLockedError extends RolleaseError {
  constructor(flagKey: string, reason?: string) {
    super(
      `Flag "${flagKey}" is locked${reason ? `: ${reason}` : ""}`,
      423,
      "FLAG_LOCKED",
      { flagKey, reason }
    );
    this.name = "FlagLockedError";
  }
}

/**
 * Thrown when creating a flag/segment/release with a duplicate key.
 */
export class FlagConflictError extends RolleaseError {
  constructor(key: string, type: string = "flag") {
    super(
      `A ${type} with key "${key}" already exists`,
      409,
      "CONFLICT",
      { key, type }
    );
    this.name = "FlagConflictError";
  }
}

/**
 * Thrown for invalid inputs: bad flag config, malformed conditions, bad semver, etc.
 */
export class ValidationError extends RolleaseError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, 422, "VALIDATION_ERROR", meta);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when deploying a release with conflicting flag states.
 */
export class ReleaseConflictError extends RolleaseError {
  constructor(releaseId: string, details?: string) {
    super(
      `Release "${releaseId}" has conflicts${details ? `: ${details}` : ""}`,
      409,
      "RELEASE_CONFLICT",
      { releaseId, details }
    );
    this.name = "ReleaseConflictError";
  }
}

/**
 * Thrown for unexpected internal errors (DB failure, cache unavailable, etc.)
 */
export class RolleaseInternalError extends RolleaseError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, 500, "INTERNAL_ERROR", meta);
    this.name = "RolleaseInternalError";
  }
}

/**
 * Thrown when a rule is not found.
 */
export class RuleNotFoundError extends RolleaseError {
  constructor(flagKey: string, ruleId: string) {
    super(
      `Rule "${ruleId}" not found on flag "${flagKey}"`,
      404,
      "RULE_NOT_FOUND",
      { flagKey, ruleId }
    );
    this.name = "RuleNotFoundError";
  }
}

/**
 * Thrown when a segment key is not found.
 */
export class SegmentNotFoundError extends RolleaseError {
  constructor(segmentKey: string) {
    super(
      `Segment "${segmentKey}" not found`,
      404,
      "SEGMENT_NOT_FOUND",
      { segmentKey }
    );
    this.name = "SegmentNotFoundError";
  }
}

/**
 * Thrown when a release is not found.
 */
export class ReleaseNotFoundError extends RolleaseError {
  constructor(releaseId: string) {
    super(
      `Release "${releaseId}" not found`,
      404,
      "RELEASE_NOT_FOUND",
      { releaseId }
    );
    this.name = "ReleaseNotFoundError";
  }
}
