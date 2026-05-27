import { describe, expect, it } from "vitest";
import {
  RolleaseError,
  FlagNotFoundError,
  FlagLockedError,
  FlagConflictError,
  ValidationError,
  ReleaseConflictError,
  RolleaseInternalError,
  RuleNotFoundError,
  SegmentNotFoundError,
  ReleaseNotFoundError,
} from "../src/core/errors";

describe("Rollease Errors", () => {
  it("should instantiate and serialize all custom errors correctly", () => {
    const errBase = new RolleaseError("base error", 400, "BASE_ERR", { details: "some details" });
    expect(errBase.message).toBe("base error");
    expect(errBase.statusCode).toBe(400);
    expect(errBase.code).toBe("BASE_ERR");
    expect(errBase.meta).toEqual({ details: "some details" });
    expect(errBase.toJSON()).toEqual({
      error: "RolleaseError",
      statusCode: 400,
      code: "BASE_ERR",
      message: "base error",
      meta: { details: "some details" },
    });

    const errNotFound = new FlagNotFoundError("flag-1");
    expect(errNotFound.name).toBe("FlagNotFoundError");
    expect(errNotFound.statusCode).toBe(404);
    expect(errNotFound.code).toBe("FLAG_NOT_FOUND");
    expect(errNotFound.meta.flagKey).toBe("flag-1");

    const errLocked = new FlagLockedError("flag-1", "locked details");
    expect(errLocked.name).toBe("FlagLockedError");
    expect(errLocked.statusCode).toBe(423);
    expect(errLocked.meta.reason).toBe("locked details");

    const errLockedNoReason = new FlagLockedError("flag-1");
    expect(errLockedNoReason.message).toBe('Flag "flag-1" is locked');

    const errConflict = new FlagConflictError("flag-1");
    expect(errConflict.name).toBe("FlagConflictError");
    expect(errConflict.statusCode).toBe(409);

    const errValidation = new ValidationError("invalid config", { field: "name" });
    expect(errValidation.name).toBe("ValidationError");
    expect(errValidation.statusCode).toBe(422);

    const errReleaseConflict = new ReleaseConflictError("rel-1", "conflict details");
    expect(errReleaseConflict.name).toBe("ReleaseConflictError");
    expect(errReleaseConflict.statusCode).toBe(409);

    const errInternal = new RolleaseInternalError("db down", { connection: "timeout" });
    expect(errInternal.name).toBe("RolleaseInternalError");
    expect(errInternal.statusCode).toBe(500);

    const errRuleNotFound = new RuleNotFoundError("flag-1", "rule-1");
    expect(errRuleNotFound.name).toBe("RuleNotFoundError");
    expect(errRuleNotFound.statusCode).toBe(404);

    const errSegmentNotFound = new SegmentNotFoundError("segment-1");
    expect(errSegmentNotFound.name).toBe("SegmentNotFoundError");
    expect(errSegmentNotFound.statusCode).toBe(404);

    const errReleaseNotFound = new ReleaseNotFoundError("rel-1");
    expect(errReleaseNotFound.name).toBe("ReleaseNotFoundError");
    expect(errReleaseNotFound.statusCode).toBe(404);
  });
});
