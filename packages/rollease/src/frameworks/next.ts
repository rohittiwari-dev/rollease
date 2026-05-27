// ============================================================================
// Rollease SDK - Next.js Integration
// Signed Edge middleware transport plus RSC helpers.
// ============================================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { FlagResult, FlagMap, FlagContext } from "../core/types";
import type { RolleaseClient } from "../index";
import { ValidationError } from "../core/errors";

const FLAGS_HEADER = "x-rollease-flags";
const FLAGS_COOKIE = "rollease-flags";
const TRANSPORT_VERSION = 1;
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
  return async (req: NextRequest) => {
    try {
      const userId = options.userIdExtractor?.(req);
      const extraContext = options.flagContext?.(req) || {};
      const context: FlagContext = { userId, ...extraContext };

      const flags = await client.flags.evaluateAll(context, {
        keys: options.flags,
      });

      const secret = resolveMiddlewareSecret(client, options.secret);
      const envelope = await createSignedFlagPayload(flags, secret);

      const requestHeaders = new Headers(req.headers);
      requestHeaders.set(FLAGS_HEADER, envelope);

      const response = NextResponse.next({
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
      return NextResponse.next();
    }
  };
}

export async function getFlag<T = unknown>(
  key: string,
  defaultValue?: T,
  options: RolleaseReadOptions = {}
): Promise<FlagResult<T>> {
  const flags = await readFlagsFromHeaders(options);

  if (flags && flags[key] !== undefined) {
    const val = flags[key];
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
  const flags = await readFlagsFromHeaders(options);
  return flags || {};
}

export async function createSignedFlagPayload(
  flags: FlagMap,
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

export async function readSignedFlagPayload(
  envelope: string,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {}
): Promise<FlagMap | null> {
  assertTransportSecret(secret);
  if (!envelope || envelope.length > MAX_TRANSPORT_LENGTH) return null;

  const [version, payload, signature, ...extra] = envelope.split(".");
  if (
    extra.length > 0 ||
    version !== `v${TRANSPORT_VERSION}` ||
    !payload ||
    !signature
  ) {
    return null;
  }

  const expected = await hmacSha256(payload, secret);
  if (!constantTimeEqual(signature, expected)) return null;

  try {
    const decoded = JSON.parse(decodeUtf8FromBase64Url(payload)) as {
      v?: number;
      ts?: number;
      flags?: unknown;
    };
    if (decoded.v !== TRANSPORT_VERSION) return null;
    if (typeof decoded.ts !== "number" || !Number.isFinite(decoded.ts)) return null;

    const now = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_TRANSPORT_AGE_MS;
    if (decoded.ts > now + 60_000) return null;
    if (now - decoded.ts > maxAgeMs) return null;
    if (!isPlainFlagMap(decoded.flags)) return null;

    return decoded.flags;
  } catch {
    return null;
  }
}

async function readFlagsFromHeaders(
  options: RolleaseReadOptions = {}
): Promise<FlagMap | null> {
  try {
    // Dynamic import keeps this module usable outside a Next.js server context.
    // @ts-ignore
    const { cookies, headers } = await import("next/headers");
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
): Promise<FlagMap | null> {
  if (!raw || raw.length > MAX_TRANSPORT_LENGTH) return null;

  if (raw.startsWith(`v${TRANSPORT_VERSION}.`)) {
    if (!secret) return null;
    return readSignedFlagPayload(raw, secret, { maxAgeMs: options.maxAgeMs });
  }

  if (!options.allowUnsigned) return null;

  try {
    const parsed = JSON.parse(raw);
    return isPlainFlagMap(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveMiddlewareSecret(client: RolleaseClient, override?: string): string {
  const secret = override ?? client.__rollease?.secret ?? readEnvSecret();
  assertTransportSecret(secret);
  return secret;
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
