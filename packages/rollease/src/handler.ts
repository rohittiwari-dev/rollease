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
import type { FlagContext, AuditActor } from "./core/types";

export interface RolleasePublicClientKeyConfig {
  /** Explicit flag keys this public key can evaluate. */
  flags?: string[];
  /** Environment names this public key can evaluate. */
  environments?: string[];
  /** Require flags to be marked `clientVisible`. Defaults to true. */
  requireClientVisible?: boolean;
  /** Server-owned context merged over caller-supplied context. */
  context?: FlagContext | ((req: Request) => FlagContext | Promise<FlagContext>);
}

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
   * Extract the actor from the incoming admin request. The actor is passed to
   * all manager write methods so RBAC hooks receive it for permission checking.
   *
   * Example: extract actor from a verified JWT or session:
   * ```ts
   * extractActor: async (req) => {
   *   const payload = await verifyJWT(req.headers.get('authorization'))
   *   return { id: payload.sub, type: 'user', name: payload.name }
   * }
   * ```
   */
  extractActor?: (req: Request) => AuditActor | undefined | Promise<AuditActor | undefined>;

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
  /**
   * Public browser/client keys. When provided, public evaluation and event
   * routes require `X-Rollease-Client-Key` or `?clientKey=...`.
   */
  clientKeys?: Record<string, RolleasePublicClientKeyConfig>;

  /**
   * Authorize the health endpoint. When not provided, `GET /health` is public.
   * Return true to allow; false to reject with 401.
   */
  healthAuth?: (req: Request) => boolean | Promise<boolean>;
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
    extractActor,
    basePath = "/api/rollease",
    cors = "*",
    clientKeys,
    healthAuth,
  } = options;

  const enc = new TextEncoder();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function corsHeaders(): Record<string, string> {
    if (!cors) return {};
    return {
      "Access-Control-Allow-Origin": cors,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Rollease-Context, X-Rollease-Client-Key",
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

  async function resolveActor(req: Request): Promise<AuditActor | undefined> {
    if (!extractActor) return undefined;
    try {
      return await extractActor(req);
    } catch {
      return undefined;
    }
  }

  async function checkHealth(req: Request): Promise<boolean> {
    if (!healthAuth) return true;
    try {
      return await healthAuth(req);
    } catch {
      return false;
    }
  }

  function getClientKey(req: Request): string | null {
    const header = req.headers.get("x-rollease-client-key");
    if (header) return header;
    const url = new URL(req.url);
    return url.searchParams.get("clientKey");
  }

  async function resolvePublicAccess(
    req: Request
  ): Promise<{ ok: true; config?: RolleasePublicClientKeyConfig } | { ok: false; status: number; message: string }> {
    if (!clientKeys) return { ok: true };
    const key = getClientKey(req);
    if (!key) return { ok: false, status: 401, message: "client key is required" };
    const config = clientKeys[key];
    if (!config) return { ok: false, status: 401, message: "invalid client key" };
    return { ok: true, config };
  }

  async function resolvePublicContext(
    req: Request,
    config?: RolleasePublicClientKeyConfig
  ): Promise<FlagContext> {
    const callerContext = await resolveContext(req);
    const ownedContext =
      typeof config?.context === "function"
        ? await config.context(req)
        : config?.context;
    return { ...callerContext, ...(ownedContext ?? {}) };
  }

  async function getPublicKeys(
    config?: RolleasePublicClientKeyConfig
  ): Promise<string[] | undefined> {
    if (!config) return undefined;
    if (config.flags) return config.flags;
    const requireVisible = config.requireClientVisible ?? true;
    const out: string[] = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const page = await manager.list({ status: "active", limit, offset });
      for (const flag of page.data) {
        if (requireVisible && !flag.clientVisible) continue;
        if (
          config.environments?.length &&
          flag.environments?.length &&
          !flag.environments.some((env) => config.environments!.includes(env))
        ) {
          continue;
        }
        out.push(flag.key);
      }
      if (!page.hasMore) break;
      offset += page.data.length;
    }
    return out;
  }

  async function canEvaluatePublicFlag(
    key: string,
    config?: RolleasePublicClientKeyConfig
  ): Promise<boolean> {
    if (!config) return true;
    if (config.flags) return config.flags.includes(key);
    const flag = await manager.get(key).catch(() => null);
    if (!flag) return false;
    if ((config.requireClientVisible ?? true) && !flag.clientVisible) return false;
    if (
      config.environments?.length &&
      flag.environments?.length &&
      !flag.environments.some((env) => config.environments!.includes(env))
    ) {
      return false;
    }
    return true;
  }

  function errName(e: unknown): string {
    return (e as { name?: string }).name ?? "";
  }

  function errMsg(e: unknown): string {
    return (e as { message?: string }).message ?? "Internal error";
  }

  function safeErrMsg(e: unknown, fallback = "Internal server error"): string {
    // Only expose validation-class error messages to clients; mask internal details.
    const name = errName(e);
    if (
      name === "ValidationError" ||
      name === "FlagNotFoundError" ||
      name === "FlagLockedError" ||
      name === "FlagConflictError" ||
      name === "ReleaseConflictError" ||
      name === "RuleNotFoundError" ||
      name === "SegmentNotFoundError"
    ) {
      return errMsg(e);
    }
    return fallback;
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
      if (!(await checkHealth(req))) return err("Unauthorized", 401);
      try {
        const result = await manager.health();
        return json(result, result.status === "unhealthy" ? 503 : 200);
      } catch {
        return json({ status: "unhealthy", ts: Date.now() }, 503);
      }
    }

    // ── Prometheus Metrics (GET /metrics) ──────────────────────────────────
    if (route === "metrics" && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const body = manager.getMetrics();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          ...corsHeaders(),
        },
      });
    }

    // ── Evaluate all flags (GET /flags) ────────────────────────────────────
    if (route === "flags" && method === "GET") {
      const access = await resolvePublicAccess(req);
      if (!access.ok) return err(access.message, access.status);
      const ctx = await resolvePublicContext(req, access.config);
      try {
        const keys = await getPublicKeys(access.config);
        const flags = await manager.evaluateAllDetailed(ctx, keys ? { keys } : undefined);
        return json({ flags, ts: Date.now() });
      } catch (e) {
        return err(errMsg(e), 500);
      }
    }

    // ── SSE stream (GET /flags/stream) ─────────────────────────────────────
    if (route === "flags/stream" && method === "GET") {
      const access = await resolvePublicAccess(req);
      if (!access.ok) return err(access.message, access.status);
      const ctx = await resolvePublicContext(req, access.config);
      const keys = await getPublicKeys(access.config);
      let unsub: (() => void) | null = null;

      const stream = new ReadableStream({
        async start(controller) {
          const push = async () => {
            try {
              const flags = await manager.evaluateAllDetailed(ctx, keys ? { keys } : undefined);
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
      const access = await resolvePublicAccess(req);
      if (!access.ok) return err(access.message, access.status);
      if (!(await canEvaluatePublicFlag(key, access.config))) {
        return err(`Flag "${key}" not found`, 404);
      }
      const ctx = await resolvePublicContext(req, access.config);
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
      const access = await resolvePublicAccess(req);
      if (!access.ok) return err(access.message, access.status);
      try {
        const ctx = await resolvePublicContext(req, access.config);
        const body = (await req.json()) as {
          userId?: string;
          anonymousId?: string;
          event: string;
          value?: number;
          metadata?: Record<string, unknown>;
          events?: Array<{
            userId?: string;
            anonymousId?: string;
            event: string;
            value?: number;
            metadata?: Record<string, unknown>;
          }>;
        };
        const events = Array.isArray(body.events) ? body.events : [body];
        if (events.length === 0) return err("event is required", 400);
        for (const event of events) {
          if (!event.event) return err("event is required", 400);
          await manager.trackEvent({
            ...event,
            userId: event.userId ?? ctx.userId,
            context: ctx,
          });
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
        const url = new URL(req.url);
        const ns = url.searchParams.get("namespace") ?? undefined;
        const status = (url.searchParams.get("status") as "active" | "killed" | "archived") ?? undefined;
        const search = url.searchParams.get("search") ?? undefined;
        const limit = Number(url.searchParams.get("limit")) || 100;
        const offset = Number(url.searchParams.get("offset")) || 0;
        const result = await manager.list({ namespace: ns, status, search, limit, offset });
        return json({ flags: result.data, total: result.total, hasMore: result.hasMore, ts: Date.now() });
      } catch (e) {
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: create flag (POST /admin/flags) ─────────────────────────────
    if (route === "admin/flags" && method === "POST") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const flag = await manager.create({ ...body, actor });
        return json(flag, 201);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: get flag (GET /admin/flags/:key) ────────────────────────────
    if (parts[0] === "admin" && parts[1] === "flags" && parts.length === 3 && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const flag = await manager.get(key);
        const rules = await manager.listRules(key);
        return json({ ...flag, rules, ts: Date.now() });
      } catch (e) {
        if (errName(e) === "FlagNotFoundError") return err(`Flag "${key}" not found`, 404);
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: update flag (PATCH /admin/flags/:key) ───────────────────────
    if (parts[0] === "admin" && parts[1] === "flags" && parts.length === 3 && method === "PATCH") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const flag = await manager.update(key, { ...body, actor });
        return json(flag);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: archive flag (DELETE /admin/flags/:key) ─────────────────────
    if (parts[0] === "admin" && parts[1] === "flags" && parts.length === 3 && method === "DELETE") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const actor = await resolveActor(req);
        await manager.archive(key, { actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
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
        const actor = await resolveActor(req);
        await manager.kill(key, { ...body, actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
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
        const actor = await resolveActor(req);
        await manager.restore(key, { ...body, actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: lock/unlock flag (POST /admin/flags/:key/lock) ─────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "lock" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        const actor = await resolveActor(req);
        await manager.setLock(key, { ...body, actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
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
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: list rules (GET /admin/flags/:key/rules) ────────────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "rules" && method === "GET"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const rules = await manager.listRules(key);
        return json({ rules, ts: Date.now() });
      } catch (e) {
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: add rule (POST /admin/flags/:key/rules) ─────────────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "rules" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const rule = await manager.addRule(key, { ...body, actor });
        return json(rule, 201);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: update rule (PATCH /admin/flags/:key/rules/:ruleId) ─────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 5 && parts[3] === "rules" && method === "PATCH"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      const ruleId = decodeURIComponent(parts[4]);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const rule = await manager.updateRule(key, ruleId, { ...body, actor });
        return json(rule);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: remove rule (DELETE /admin/flags/:key/rules/:ruleId) ────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 5 && parts[3] === "rules" && method === "DELETE"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      const ruleId = decodeURIComponent(parts[4]);
      try {
        const actor = await resolveActor(req);
        await manager.removeRule(key, ruleId, { actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: set rollout (POST /admin/flags/:key/rollout) ────────────────
    if (
      parts[0] === "admin" && parts[1] === "flags" &&
      parts.length === 4 && parts[3] === "rollout" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        await manager.setRollout(key, body.rollout ?? body, { actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: list segments (GET /admin/segments) ─────────────────────────
    if (route === "admin/segments" && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const segments = await manager.listSegments();
        return json({ segments, ts: Date.now() });
      } catch (e) {
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: create segment (POST /admin/segments) ───────────────────────
    if (route === "admin/segments" && method === "POST") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const segment = await manager.createSegment({ ...body, actor });
        return json(segment, 201);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: update segment (PATCH /admin/segments/:key) ─────────────────
    if (parts[0] === "admin" && parts[1] === "segments" && parts.length === 3 && method === "PATCH") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const segment = await manager.updateSegment(key, { ...body, actor });
        return json(segment);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: delete segment (DELETE /admin/segments/:key) ────────────────
    if (parts[0] === "admin" && parts[1] === "segments" && parts.length === 3 && method === "DELETE") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const key = decodeURIComponent(parts[2]);
      try {
        const actor = await resolveActor(req);
        await manager.deleteSegment(key, { actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: list releases (GET /admin/releases) ─────────────────────────
    if (route === "admin/releases" && method === "GET") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const url = new URL(req.url);
        const environment = url.searchParams.get("environment") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const limit = Number(url.searchParams.get("limit")) || 50;
        const releases = await manager.listReleases({ environment, status, limit });
        return json({ releases, ts: Date.now() });
      } catch (e) {
        return err(safeErrMsg(e), 500);
      }
    }

    // ── Admin: create release (POST /admin/releases) ───────────────────────
    if (route === "admin/releases" && method === "POST") {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      try {
        const body = await req.json();
        const actor = await resolveActor(req);
        const release = await manager.createRelease({ ...body, actor });
        return json(release, 201);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: deploy release (POST /admin/releases/:id/deploy) ───────────
    if (
      parts[0] === "admin" && parts[1] === "releases" &&
      parts.length === 4 && parts[3] === "deploy" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const releaseId = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        const actor = await resolveActor(req);
        await manager.deployRelease(releaseId, { ...body, actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: rollback release (POST /admin/releases/:id/rollback) ────────
    if (
      parts[0] === "admin" && parts[1] === "releases" &&
      parts.length === 4 && parts[3] === "rollback" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const releaseId = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        const actor = await resolveActor(req);
        await manager.rollbackRelease(releaseId, { ...body, actor });
        return new Response(null, { status: 204, headers: corsHeaders() });
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: approve release (POST /admin/releases/:id/approve) ──────────
    if (
      parts[0] === "admin" && parts[1] === "releases" &&
      parts.length === 4 && parts[3] === "approve" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const releaseId = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        const actor = await resolveActor(req);
        const approverId = body.approverId ?? actor?.id ?? "unknown";
        const release = await manager.approveRelease(releaseId, approverId, { actor });
        return json(release);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    // ── Admin: reject release (POST /admin/releases/:id/reject) ───────────
    if (
      parts[0] === "admin" && parts[1] === "releases" &&
      parts.length === 4 && parts[3] === "reject" && method === "POST"
    ) {
      if (!(await checkAdmin(req))) return err("Unauthorized", 401);
      const releaseId = decodeURIComponent(parts[2]);
      try {
        const body = await req.json().catch(() => ({}));
        const actor = await resolveActor(req);
        const rejectorId = body.rejectorId ?? actor?.id ?? "unknown";
        const release = await manager.rejectRelease(releaseId, rejectorId, { reason: body.reason, actor });
        return json(release);
      } catch (e) {
        return err(safeErrMsg(e), 400);
      }
    }

    return err("Not found", 404);
  };
}
