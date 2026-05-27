// ============================================================================
// Rollease SDK — Local Developer Overrides
// Reads .rolleaserc.json for development-time flag overrides.
// ============================================================================

import * as fs from "fs";
import * as path from "path";

let cachedOverrides: Record<string, unknown> | null = null;
let lastReadAt = 0;
const CACHE_TTL_MS = 5000; // Re-read file every 5 seconds

/**
 * Load local overrides from a JSON file.
 * Returns an empty object if the file doesn't exist or is invalid.
 *
 * @param filePath - Path to the overrides file (default: '.rolleaserc.json')
 */
export function loadLocalOverrides(
  filePath: string = ".rolleaserc.json"
): Record<string, unknown> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedOverrides && now - lastReadAt < CACHE_TTL_MS) {
    return cachedOverrides;
  }

  try {
    const resolved = path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(resolved)) {
      cachedOverrides = {};
      lastReadAt = now;
      return cachedOverrides;
    }

    const content = fs.readFileSync(resolved, "utf-8");
    cachedOverrides = JSON.parse(content);
    lastReadAt = now;
    return cachedOverrides || {};
  } catch {
    cachedOverrides = {};
    lastReadAt = now;
    return cachedOverrides;
  }
}

/**
 * Clear the overrides cache (useful for testing).
 */
export function clearOverrideCache(): void {
  cachedOverrides = null;
  lastReadAt = 0;
}
