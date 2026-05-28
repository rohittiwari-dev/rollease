// ============================================================================
// Rollease SDK — Universal HTTP Handler
// ============================================================================
//
// Creates a fetch-compatible (Request → Response) handler that mounts all
// Rollease routes at a configurable base path.  Works with Next.js App Router,
// Hono, Fastify, Express, Cloudflare Workers — any runtime that speaks the
// Fetch API.
//
// Usage (Next.js App Router):
//
//   // app/api/rollease/[...path]/route.ts
//   import { rl } from '@/lib/rollease'
//
//   const handler = rl.createHandler({
//     contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
//     adminAuth:           async (req) => req.headers.get('x-admin-token') === process.env.ADMIN_TOKEN,
//   })
//
//   export const GET  = handler
//   export const POST = handler
//   export const PATCH  = handler
//   export const DELETE = handler
//
// Usage (Hono):
//
//   const handler = rl.createHandler({ contextFromRequest: ... })
//   app.all('/api/rollease/*', (c) => handler(c.req.raw))

import type { FlagManager } from "./engine/manager";
import type { FlagContext } from "./core/types";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RolleaseHandlerOptions {
  /**
   * Extract the caller's FlagContext from the incoming Request.
   * Required for flag evaluation endpoints.  When omitted, the handler falls
   * back to the `X-Rollease-Context` header (base64url-encoded JSON).
   */
  contextFromRequest?: (req: Request) => FlagContext | Promise<FlagContext>;

  /**
   * Authorize admin (write) routes: flag CRUD, history.
   * Return true to allow; return false / throw to reject with 401.
   */
  adminAuth?: (req: Request) => boolean | Promise<boolean>;

  /**
   * The path prefix where this handler is mounted.
   * Used to strip the base from the URL before route matching.
   * @default '/api/rollease'
   */
  basePath?: string;

  /**
   * CORS origin to include in responses.  Use `false` to disable CORS headers.
   * @default '*'
   */
  cors?: string | false;
}

/** A fetch-compatible Rollease HTTP handler.  Pass directly as a Next.js route handler. */
export type RolleaseHandler = (req: Request) => Promise<Response>;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRolleaseHandler(
  manager: FlagManager,
  options: RolleaseHandlerOptions = {}
): RolleaseHandler {
  const {
    contextFromRequest,
    adminAuth,
    basePath = "/api/rollease",
    cors = "*",
  } = options;

  const enc = new TextEncoder();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function corsHeaders(): Record<string, string> {
    if (!cors) return {};
    return {
      "Access-Control-Allow-Origin": cors,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Rollease-Context",
      "Access-Control-Max-Age": "86400",
    };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  function err(message: string, status: number): Response {
    return json({ error: message }, status);
  }

  function extractRoute(req: Request): { route: string; parts: string[] } {
    const url = new URL(req.url);
    let path = url.pathname;
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length);
    }
    const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const route = parts.join("/");
    return { route, parts };
  }

  async function resolveContext(req: Request): Promise<FlagContext> {
    if (contextFromRequest) {
      return contextFromRequest(req);
    }
    const header = req.headers.get("x-rollease-context");
    if (header) {
      try {
        return JSON.parse(
          typeof atob !== "undefined"
            ? atob(header)
            : Buffer.from(header, "base64").toString()
        ) as FlagContext;
      } catch {
        // malformed — continue to empty context
      }
    }
    const url = new URL(req.url);
    const param = url.searchParams.get("context");
    if (param) {
      try {
        return JSON.parse(
          typeof atob !== "undefined"
            ? atob(param)
            : Buffer.from(param, "base64").toString()
        ) as FlagContext;
      } catch {
        // malformed — continue to empty context
      }
    }
    return {};
  }

  async function checkAdmin(req: Request): Promise<boolean> {
    if (!adminAuth) return false;
    try {
      return await adminAuth(req);
    } catch {
      return false;
    }
  }

  function errName(e: unknown): string {
    return (e as { name?: string }).name ?? "";
  }

  function errMsg(e: unknown): string {
    return (e as { message?: string }).message ?? "Internal error";
  }

  // ── Main handler ───────────────────────────────────────────────────────────

  return async function handler(req: Request): Promise<Response> {
    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const { route, parts } = extractRoute(req);
    const method = req.method.toUpperCase();

    // ── Health ─────────────────────────────────────────────────────────────
    if ((route === "health" || route === "") && method === "GET") {
      try {
        const result = await manager.health();
        return json(result, result.status === "unhealthy" ? 503 : 200);
      } catch {
        return json({ status: "unhealthy", ts: Date.now() }, 503);
      }
    }

    // ── Evaluate all flags (GET /flags) ────────────────────────────────────
    if (route === "flags" && method === "GET") {
      const ctx = await resolveContext(req);
      try {
        const flags = await manager.evaluateAllDetailed(ctx);
        return json({ flags, ts: Date.now() });
      } catch (e) {
        return err(errMsg(e), 500);
      }
    }

    // ── SSE stream (GET /flags/stream) ─────────────────────────────────────
    if (route === "flags/stream" && method === "GET") {
      const ctx = await resolveContext(req);
      let unsub: (() => void) | null = null;

      const stream = new ReadableStream({
        async start(controller) {
          const push = async () => {
            try {
              const flags = await manager.evaluateAllDetailed(ctx);
              const line = `data: ${JSON.stringify({ flags, ts: Date.now() })}\n\n`;
              controller.enqueue(enc.encode(line));
            } catch {
              // keep the stream alive; transient errors shouldn't kill SSE
            }
          };

          await push();
          unsub = manager.onChange(push);

          req.signal?.addEventListener("abort", () => {
            unsub?.();
            try { controller.close(); } catch { /* already closed */ }
          });
        },
        cancel() {
          unsub?.();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // ── Evaluate single flag (GET /flags/:key) ─────────────────────────────
    if (parts[0] === "flags" && parts.length === 2 && method === "GET") {
      const key = decodeURIComponent(parts[1]);
      const ctx = await resolveContext(req);
      try {
        const result = await manager.evaluate(key, ctx);
        return json({ ...result, ts: Date.now() });
      } catch (e) {
        if (errName(e) === "FlagNotFoundError") return err(`Flag "${key}" not found`, 404);
        return err(errMsg(e), 500);
      }
    }

    // ── Track event (POST /events) ─────────────────────────────────────────
    if (route === "events" && method === "POST") {
      try {
        const body = (await req.json()) as {
          userId?: string;
          event: string;
          value?: number;
          metadata?: Record<string, unknown>;
        };
        if (!body.event) return err("event is required", 400);
        // No-op if adapter doesn't support event tracking yet
        const m = manager as unknown as { trackEvent?: (e: unknown) => Promise<void> };
        if (typeof m.trackEvent === "function") {
          await m.trackEvent(body);
        }
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch {
        return err("Invalid request body", 400);
      }
    }

    // ── Admin: list flags (GET /admin/flags) ───────────────────────────────
    if (route === "admin/flags" && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const result = await manager.list({});
        return json({ flags: result.data, total: result.total, ts: Date.now() });
      } catch (e) {
        return err(errMsg(e), 500);
      }
    }

    // ── Admin: create flag (POST /admin/flags) ─────────────────────────────
    if (route === "admin/flags" && method === "POST") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const body = await req.json();
        const flag = await manager.create(body);
        return json(flag, 201);
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    // ── Admin: update flag (PATCH /admin/flags/:key) ───────────────────────
    if (parts[0] === "admin" && parts[1] === "flags" && parts.length === 3 && method === "PATCH") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json();
        const flag = await manager.update(key, body);
        return json(flag);
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    // ── Admin: archive flag (DELETE /admin/flags/:key) ─────────────────────
    if (parts[0] === "admin" && parts[1] === "flags" && parts.length === 3 && method === "DELETE") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        await manager.archive(key, {});
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    // ── Admin: kill flag (POST /admin/flags/:key/kill) ─────────────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "kill" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        await manager.kill(key, body);
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    // ── Admin: restore flag (POST /admin/flags/:key/restore) ──────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "restore" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        await manager.restore(key, body);
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    // ── Admin: flag history (GET /admin/flags/:key/history) ────────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "history" && method === "GET"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const history = await manager.getHistory(key);
        return json({ history, ts: Date.now() });
      } catch (e) {
        return err(errMsg(e), 500);
      }
    }

    // ── Admin: list segments (GET /admin/segments) ─────────────────────────
    if (route === "admin/segments" && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const segments = await manager.listSegments();
        return json({ segments, ts: Date.now() });
      } catch (e) {
        return err(errMsg(e), 500);
      }
    }

    // ── Admin: create segment (POST /admin/segments) ───────────────────────
    if (route === "admin/segments" && method === "POST") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const body = await req.json();
        const segment = await manager.createSegment(body);
        return json(segment, 201);
      } catch (e) {
        return err(errMsg(e), 400);
      }
    }

    return err("Not found", 404);
  };
}
