// ============================================================================
// Rollease SDK — Webhook Dispatcher
//
// Edge-safe: uses Web Crypto (SubtleCrypto) for HMAC signing rather than
// Node's `crypto` module, so this works in Cloudflare Workers, Vercel Edge,
// and Deno without polyfills. `fetch` is assumed to be globally available
// (which it is on Node 18+, Bun, all Edge runtimes, all browsers).
// ============================================================================

import type { HistoryAction, WebhookConfig, WebhookPayload } from "./types";
import type { RolleaseLogger } from "./logger";

const DEFAULT_TIMEOUT_MS = 3000;
const SIGNATURE_HEADER = "X-Rollease-Signature";
const SIGNATURE_VERSION_HEADER = "X-Rollease-Signature-Version";
const TIMESTAMP_HEADER = "X-Rollease-Timestamp";
const SIGNATURE_VERSION = "v1";

export class WebhookDispatcher {
  private configs: WebhookConfig[];
  private logger: RolleaseLogger;
  private listeners: Map<
    HistoryAction | "*",
    Set<(payload: WebhookPayload) => void | Promise<void>>
  >;

  constructor(configs: WebhookConfig[] = [], logger: RolleaseLogger) {
    this.configs = configs;
    this.logger = logger;
    this.listeners = new Map();
  }

  /** Register a local Javascript/Typescript event listener callback */
  on(
    event: HistoryAction | "*",
    callback: (payload: WebhookPayload) => void | Promise<void>
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  /** Remove a local Javascript/Typescript event listener callback */
  off(
    event: HistoryAction | "*",
    callback: (payload: WebhookPayload) => void | Promise<void>
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
    }
  }

  /** Dispatch a history action to both local JS listeners and HTTP webhooks */
  dispatch(
    event: HistoryAction,
    flagKey: string | undefined,
    data: Record<string, unknown>
  ): void {
    const payload: WebhookPayload = {
      event,
      flagKey,
      timestamp: new Date().toISOString(),
      data,
    };

    // 1) Local JS listeners — fire-and-forget, never throw.
    const targets = [
      ...(this.listeners.get(event) ?? []),
      ...(this.listeners.get("*") ?? []),
    ];
    for (const listener of targets) {
      try {
        const ret = listener(payload);
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          (ret as Promise<unknown>).catch((err) =>
            this.logger.error("local webhook listener rejected", {
              event,
              flagKey,
              err: errMessage(err),
            })
          );
        }
      } catch (err) {
        this.logger.error("local webhook listener threw", {
          event,
          flagKey,
          err: errMessage(err),
        });
      }
    }

    // 2) HTTP webhooks — fire-and-forget; per-config event-name filter.
    for (const config of this.configs) {
      if (config.events && !config.events.includes(event)) continue;
      void this.sendHttpWebhook(config, payload);
    }
  }

  private async sendHttpWebhook(
    config: WebhookConfig,
    payload: WebhookPayload
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Rollease-Webhook/1.0",
      [TIMESTAMP_HEADER]: payload.timestamp,
      ...config.headers,
    };

    if (config.secret) {
      try {
        const signature = await hmacSha256Hex(
          `${payload.timestamp}.${body}`,
          config.secret
        );
        headers[SIGNATURE_HEADER] = signature;
        headers[SIGNATURE_VERSION_HEADER] = SIGNATURE_VERSION;
      } catch (err) {
        this.logger.error("webhook signing failed", {
          url: config.url,
          err: errMessage(err),
        });
        return;
      }
    }

    if (typeof fetch !== "function") {
      this.logger.error(
        "webhook delivery skipped — fetch is not available in this runtime",
        { url: config.url }
      );
      return;
    }

    const controller =
      typeof AbortController === "function" ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
      : null;

    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller?.signal,
      });
      if (!res.ok) {
        this.logger.warn("webhook delivery non-2xx response", {
          url: config.url,
          status: res.status,
          statusText: res.statusText,
        });
      }
    } catch (err) {
      this.logger.error("webhook delivery failed", {
        url: config.url,
        err: errMessage(err),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

/**
 * Verify a webhook signature on the receiving side. Use this in your webhook
 * handler to confirm the request actually came from Rollease.
 *
 * ```ts
 * const valid = await verifyWebhookSignature(
 *   rawBody, request.headers['x-rollease-signature'],
 *   request.headers['x-rollease-timestamp'], secret
 * )
 * ```
 *
 * The timestamp window (default 5 minutes) protects against replay attacks.
 */
export async function verifyWebhookSignature(
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {}
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60 * 1000;
  if (ts > now + 60_000) return false;
  if (now - ts > maxAgeMs) return false;

  let expected: string;
  try {
    expected = await hmacSha256Hex(`${timestamp}.${body}`, secret);
  } catch {
    return false;
  }
  return constantTimeEqual(signature, expected);
}

// ── Web Crypto helpers ─────────────────────────────────────────────────────

async function hmacSha256Hex(data: string, secret: string): Promise<string> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bytesToHex(new Uint8Array(signature));
}

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle === "object") {
    return globalThis.crypto.subtle;
  }
  throw new Error(
    "Web Crypto SubtleCrypto is not available in this runtime — webhook signing requires Node 16+, Bun, Deno, or an Edge runtime."
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
