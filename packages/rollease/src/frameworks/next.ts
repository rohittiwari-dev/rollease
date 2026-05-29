// ============================================================================
// Rollease SDK - Next.js Integration
// Signed Edge middleware transport plus RSC helpers.
//
// `next/server` and `next/headers` are imported dynamically so this module
// can be loaded in non-Next contexts (plain Node, vitest, CLIs) without
// crashing at import time.
// ============================================================================

import type {
  DetailedFlagMap,
  FlagContext,
  FlagMap,
  FlagResult,
} from "../core/types";
import type { RolleaseClient } from "../index";
import { ValidationError } from "../core/errors";
import { INTERNAL_SECRET, type WithInternalSecret } from "../core/internal";

// Loosely typed to avoid forcing a hard dependency on `next` for type
// declarations. The static type import would otherwise fail in environments
// where `next` is not installed (it's an optional peer dep).
type NextRequest = {
  headers: Headers;
  cookies?: { get(name: string): { value: string } | undefined };
  url?: string;
  geo?: { country?: string };
} & Record<string, unknown>;
type NextResponseLike = {
  cookies: { set(name: string, value: string, opts?: Record<string, unknown>): void };
};
type NextServerModule = {
  NextResponse: { next(args?: { request?: { headers: Headers } }): NextResponseLike };
};
type NextHeadersModule = {
  headers: () => Promise<{ get(name: string): string | null }>;
  cookies: () => Promise<{
    get(name: string): { value: string } | undefined;
  }>;
};

const FLAGS_HEADER = "x-rollease-flags";
const FLAGS_COOKIE = "rollease-flags";
const TRANSPORT_VERSION = 2;
const LEGACY_TRANSPORT_VERSION = 1;
const DEFAULT_MAX_TRANSPORT_AGE_MS = 5 * 60 * 1000;
const MAX_TRANSPORT_LENGTH = 16 * 1024;

export interface RolleaseMiddlewareOptions {
  /** Extract userId from the request (e.g. from JWT, session cookie). */
  userIdExtractor?: (req: NextRequest) => string | undefined;
  /** Build flag context from the request. */
  flagContext?: (req: NextRequest) => Partial<FlagContext>;
  /** Specific flag keys to pre-evaluate. Omit to evaluate all flags. */
  flags?: string[];
  /** Signing secret for header/cookie transport. Defaults to createRollease({ secret }). */
  secret?: string;
  /** Maximum signed envelope size in bytes (default 16 KiB). */
  maxPayloadBytes?: number;
}

export interface RolleaseReadOptions {
  /** Signing secret used by rolleaseMiddleware. Defaults to process.env.ROLLEASE_SECRET. */
  secret?: string;
  /** Maximum age for signed flag envelopes. Defaults to 5 minutes. */
  maxAgeMs?: number;
  /** Migration escape hatch for legacy unsigned JSON transports. Disabled by default. */
  allowUnsigned?: boolean;
}

export function rolleaseMiddleware(
  client: RolleaseClient,
  options: RolleaseMiddlewareOptions = {}
) {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_TRANSPORT_LENGTH;

  return async (req: NextRequest) => {
    let NextResponseCtor: NextServerModule["NextResponse"];
    try {
      // Lazy import keeps this module loadable in non-Next runtimes.
      const mod = (await import("next/server" as string)) as NextServerModule;
      NextResponseCtor = mod.NextResponse;
    } catch (err) {
      console.error(
        "[Rollease] rolleaseMiddleware requires the 'next' package to be installed.",
        err
      );
      throw err;
    }

    try {
      const userId = options.userIdExtractor?.(req);
      const extraContext = options.flagContext?.(req) || {};
      const context: FlagContext = { userId, ...extraContext };

      const detailed = await client.flags.evaluateAllDetailed(context, {
        keys: options.flags,
      });

      const signingInfo = resolveMiddlewareSecret(client, options.secret);
      const envelope = await createSignedDetailedPayload(detailed, signingInfo.secret);

      if (envelope.length > maxPayloadBytes) {
        console.warn(
          "[Rollease] signed flag envelope exceeds maxPayloadBytes; consider narrowing `flags` or `namespace`",
          { bytes: envelope.length, max: maxPayloadBytes }
        );
      }

      const requestHeaders = new Headers(req.headers);
      requestHeaders.set(FLAGS_HEADER, envelope);

      const response = NextResponseCtor.next({
        request: { headers: requestHeaders },
      });

      response.cookies.set(FLAGS_COOKIE, encodeURIComponent(envelope), {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      });

      return response;
    } catch (error) {
      console.error("[Rollease] Middleware evaluation failed:", error);
      return NextResponseCtor.next();
    }
  };
}

export async function getFlag<T = unknown>(
  key: string,
  defaultValue?: T,
  options: RolleaseReadOptions = {}
): Promise<FlagResult<T>> {
  const transport = await readFlagsFromHeaders(options);

  if (transport && transport.detailed && transport.detailed[key]) {
    const result = transport.detailed[key];
    return {
      key,
      value: result.value as T,
      variant: result.variant,
      enabled: result.enabled,
      reason: result.reason,
      ruleId: result.ruleId,
      evaluatedAt: new Date(result.evaluatedAt),
    };
  }

  if (transport && transport.flat && transport.flat[key] !== undefined) {
    const val = transport.flat[key];
    return {
      key,
      value: val as T,
      variant: null,
      enabled: Boolean(val),
      reason: "default",
      ruleId: null,
      evaluatedAt: new Date(),
    };
  }

  return {
    key,
    value: defaultValue as T,
    variant: null,
    enabled: false,
    reason: "default",
    ruleId: null,
    evaluatedAt: new Date(),
  };
}

export async function getAllFlags(
  options: RolleaseReadOptions = {}
): Promise<FlagMap> {
  const transport = await readFlagsFromHeaders(options);
  if (!transport) return {};
  if (transport.detailed) {
    const out: FlagMap = {};
    for (const [k, r] of Object.entries(transport.detailed)) {
      out[k] = r.value;
    }
    return out;
  }
  return transport.flat ?? {};
}

/** Return the full detailed map (variant + reason preserved). */
export async function getAllFlagsDetailed(
  options: RolleaseReadOptions = {}
): Promise<DetailedFlagMap> {
  const transport = await readFlagsFromHeaders(options);
  if (!transport || !transport.detailed) return {};
  // Rehydrate evaluatedAt — JSON-stringified dates come back as ISO strings.
  const out: DetailedFlagMap = {};
  for (const [k, r] of Object.entries(transport.detailed)) {
    out[k] = { ...r, evaluatedAt: new Date(r.evaluatedAt) };
  }
  return out;
}

// ── Transport: v2 (detailed) ───────────────────────────────────────────────

export async function createSignedDetailedPayload(
  flags: DetailedFlagMap,
  secret: string,
  now = Date.now()
): Promise<string> {
  assertTransportSecret(secret);
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ v: TRANSPORT_VERSION, ts: now, flags })
    )
  );
  const signature = await hmacSha256(payload, secret);
  return `v${TRANSPORT_VERSION}.${payload}.${signature}`;
}

// ── Transport: v1 (legacy, kept for one release as compat) ─────────────────

export async function createSignedFlagPayload(
  flags: FlagMap,
  secret: string,
  now = Date.now()
): Promise<string> {
  assertTransportSecret(secret);
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ v: LEGACY_TRANSPORT_VERSION, ts: now, flags })
    )
  );
  const signature = await hmacSha256(payload, secret);
  return `v${LEGACY_TRANSPORT_VERSION}.${payload}.${signature}`;
}

export async function readSignedFlagPayload(
  envelope: string,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {}
): Promise<FlagMap | null> {
  const parsed = await readSignedEnvelope(envelope, secret, opts);
  if (!parsed) return null;
  if (parsed.detailed) {
    const out: FlagMap = {};
    for (const [k, r] of Object.entries(parsed.detailed)) {
      out[k] = r.value;
    }
    return out;
  }
  return parsed.flat ?? null;
}

// ── Internal envelope parsing ──────────────────────────────────────────────

interface ParsedTransport {
  flat?: FlagMap;
  detailed?: Record<string, SerializedFlagResult>;
}

interface SerializedFlagResult {
  key: string;
  value: unknown;
  variant: string | null;
  enabled: boolean;
  reason: FlagResult["reason"];
  ruleId: string | null;
  evaluatedAt: string;
}

async function readSignedEnvelope(
  envelope: string,
  signingInfo: ResolvedSigningInfo | string,
  opts: { maxAgeMs?: number; now?: number } = {}
): Promise<ParsedTransport | null> {
  const info: ResolvedSigningInfo =
    typeof signingInfo === "string" ? { secret: signingInfo } : signingInfo;
  assertTransportSecret(info.secret);
  if (!envelope || envelope.length > MAX_TRANSPORT_LENGTH) return null;

  const [version, payload, signature, ...extra] = envelope.split(".");
  if (extra.length > 0 || !payload || !signature) return null;

  const isV1 = version === `v${LEGACY_TRANSPORT_VERSION}`;
  const isV2 = version === `v${TRANSPORT_VERSION}`;
  if (!isV1 && !isV2) return null;

  // Try all keys in the ring — allows gradual secret rotation.
  const candidates = info.keyRing?.length
    ? info.keyRing.map((k) => k.secret)
    : [info.secret];
  let verified = false;
  for (const candidateSecret of candidates) {
    const expected = await hmacSha256(payload, candidateSecret);
    if (constantTimeEqual(signature, expected)) { verified = true; break; }
  }
  if (!verified) return null;

  try {
    const decoded = JSON.parse(decodeUtf8FromBase64Url(payload)) as {
      v?: number;
      ts?: number;
      flags?: unknown;
    };
    if (
      decoded.v !== TRANSPORT_VERSION &&
      decoded.v !== LEGACY_TRANSPORT_VERSION
    ) {
      return null;
    }
    if (typeof decoded.ts !== "number" || !Number.isFinite(decoded.ts)) {
      return null;
    }

    const now = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_TRANSPORT_AGE_MS;
    if (decoded.ts > now + 60_000) return null;
    if (now - decoded.ts > maxAgeMs) return null;

    if (decoded.v === TRANSPORT_VERSION) {
      if (!isDetailedFlagMap(decoded.flags)) return null;
      return { detailed: decoded.flags };
    }

    // v1
    if (!isPlainFlagMap(decoded.flags)) return null;
    console.warn(
      "[Rollease] received legacy v1 flag envelope — upgrade middleware to v2 (variant/reason lost)"
    );
    return { flat: decoded.flags };
  } catch {
    return null;
  }
}

async function readFlagsFromHeaders(
  options: RolleaseReadOptions = {}
): Promise<ParsedTransport | null> {
  try {
    // Lazy: only loaded when actually running inside a Next.js server.
    const { cookies, headers } = (await import("next/headers" as string)) as NextHeadersModule;
    const secret = options.secret ?? readEnvSecret();

    const headersList = await headers();
    const headerVal = headersList.get(FLAGS_HEADER);
    if (headerVal) {
      const parsed = await parseTransportValue(headerVal, secret, options);
      if (parsed) return parsed;
    }

    const cookieStore = await cookies();
    const cookieVal = cookieStore.get(FLAGS_COOKIE)?.value;
    if (cookieVal) {
      const parsed = await parseTransportValue(
        decodeURIComponent(cookieVal),
        secret,
        options
      );
      if (parsed) return parsed;
    }
  } catch {
    // Silently fallback if run outside Next.js server context.
  }

  return null;
}

async function parseTransportValue(
  raw: string,
  secret: string | undefined,
  options: RolleaseReadOptions
): Promise<ParsedTransport | null> {
  if (!raw || raw.length > MAX_TRANSPORT_LENGTH) return null;

  if (
    raw.startsWith(`v${TRANSPORT_VERSION}.`) ||
    raw.startsWith(`v${LEGACY_TRANSPORT_VERSION}.`)
  ) {
    if (!secret) return null;
    return readSignedEnvelope(raw, secret, { maxAgeMs: options.maxAgeMs });
  }

  if (!options.allowUnsigned) return null;

  try {
    const parsed = JSON.parse(raw);
    return isPlainFlagMap(parsed) ? { flat: parsed } : null;
  } catch {
    return null;
  }
}

interface ResolvedSigningInfo {
  secret: string;
  keyRing?: Array<{ kid: string; secret: string }>;
}

function resolveMiddlewareSecret(client: RolleaseClient, override?: string): ResolvedSigningInfo {
  const internalGetter = (client as WithInternalSecret)[INTERNAL_SECRET];
  const fromInternal = typeof internalGetter === "function" ? internalGetter() : undefined;
  // fromInternal may be { secret, keyRing, currentKeyId } (new) or a string (old shim).
  if (override) {
    assertTransportSecret(override);
    return { secret: override };
  }
  if (fromInternal && typeof fromInternal === "object" && "secret" in fromInternal) {
    const info = fromInternal as { secret: string; keyRing: Array<{ kid: string; secret: string }> };
    assertTransportSecret(info.secret);
    return { secret: info.secret, keyRing: info.keyRing };
  }
  // Backwards-compat shim: older client objects exposed `__rollease.secret`.
  const legacy = (client as { __rollease?: { secret?: string } }).__rollease?.secret;
  const secret = (fromInternal as string | undefined) ?? legacy ?? readEnvSecret();
  assertTransportSecret(secret);
  return { secret };
}

function assertTransportSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new ValidationError(
      "Rollease transport secret must be at least 16 characters long"
    );
  }
}

function readEnvSecret(): string | undefined {
  try {
    if (typeof process !== "undefined") {
      return process.env.ROLLEASE_SECRET;
    }
  } catch {
    // Ignore environments without process.
  }
  return undefined;
}

async function hmacSha256(data: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeUtf8FromBase64Url(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function isPlainFlagMap(value: unknown): value is FlagMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDetailedFlagMap(
  value: unknown
): value is Record<string, SerializedFlagResult> {
  if (!isPlainFlagMap(value)) return false;
  for (const entry of Object.values(value)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("reason" in entry) ||
      !("evaluatedAt" in entry) ||
      !("enabled" in entry)
    ) {
      return false;
    }
  }
  return true;
}

// ── Universal handler → Next.js route handler adapter ────────────────────────

/**
 * Wraps a Rollease universal handler (from `rl.createHandler()`) into the
 * named-export shape that Next.js App Router route handlers expect.
 *
 * Usage in `app/api/rollease/[...path]/route.ts`:
 * ```ts
 * import { rl } from '@/lib/rollease'
 * import { toNextHandlers } from 'rollease/next'
 *
 * export const { GET, POST, PATCH, DELETE } = toNextHandlers(
 *   rl.createHandler({
 *     contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
 *   })
 * )
 * ```
 *
 * Note: `rl.createHandler()` already returns a fetch-compatible handler that
 * Next.js App Router accepts directly.  This helper is purely for convenience
 * when you prefer the named-export destructuring pattern.
 */
export function toNextHandlers(handler: (req: Request) => Promise<Response>): {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  PATCH: (req: Request) => Promise<Response>;
  DELETE: (req: Request) => Promise<Response>;
  OPTIONS: (req: Request) => Promise<Response>;
} {
  return {
    GET: handler,
    POST: handler,
    PATCH: handler,
    DELETE: handler,
    OPTIONS: handler,
  };
}
