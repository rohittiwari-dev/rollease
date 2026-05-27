// ============================================================================
// Rollease SDK — Local Developer Overrides
// Reads .rolleaserc.json for development-time flag overrides.
//
// Edge-safe: `fs` is loaded lazily and only on Node. The previous
// module-level cache has been removed — caching is now the FlagManager's
// responsibility so multiple Rollease instances with different override files
// don't share state.
// ============================================================================

import { validateOverridePath } from "./core/security";

const DEFAULT_FILE = ".rolleaserc.json";

type NodeFsModule = {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
};

let cachedFs: NodeFsModule | null | undefined;

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof (process as { versions?: { node?: string } }).versions?.node ===
      "string"
  );
}

function loadFs(): NodeFsModule | null {
  if (cachedFs !== undefined) return cachedFs;
  if (!isNodeRuntime()) {
    cachedFs = null;
    return null;
  }
  try {
    // Strategy 1: Classic CJS `require` hidden from bundlers via eval.
    // Works in plain Node CJS and older bundler outputs.
    const req = (0, eval)("require") as NodeRequire;
    cachedFs = req("fs") as NodeFsModule;
    return cachedFs;
  } catch {
    // `require` not in scope — likely an ESM environment.
  }
  try {
    // Strategy 2: `Function` constructor runs in global scope but can
    // capture the `require` injected by bundlers (esbuild, tsx, vitest)
    // into the module wrapper. We pass it through as a parameter.
    const tryReq = new Function(
      "r",
      'return typeof r === "function" ? r("fs") : null'
    );
    // In CJS-transformed ESM (tsx, vitest), `require` is defined in the
    // module scope. We reference it through this file's own scope by
    // evaluating a non-strict expression that lets us reach upward.
    const fs = tryReq(
      typeof require !== "undefined" ? require : undefined
    ) as NodeFsModule | null;
    if (fs) {
      cachedFs = fs;
      return cachedFs;
    }
  } catch {
    // Not available via this path either.
  }
  cachedFs = null;
  return cachedFs;
}

/**
 * Load local overrides from a JSON file. Returns an empty object on any
 * failure (missing file, invalid JSON, non-Node runtime).
 *
 * Caching is the caller's responsibility — each call hits disk. FlagManager
 * memoizes per-instance for ~5s.
 *
 * @param filePath - Path to the overrides file (default: '.rolleaserc.json')
 * @param cwd - Override the working directory (used in tests)
 */
export function loadLocalOverrides(
  filePath: string = DEFAULT_FILE,
  cwd: string = isNodeRuntime() ? process.cwd() : "/"
): Record<string, unknown> {
  const fs = loadFs();
  if (!fs) return {};

  let resolved: string;
  try {
    resolved = validateOverridePath(filePath, cwd);
  } catch {
    // Reject path-traversal silently — local overrides are advisory only.
    return {};
  }

  try {
    if (!fs.existsSync(resolved)) return {};
    const content = fs.readFileSync(resolved, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Test-only: reset the cached fs reference so tests can simulate Edge runtimes.
 */
export function _resetOverridesRuntimeCache(): void {
  cachedFs = undefined;
}
