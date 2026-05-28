// ============================================================================
// Rollease SDK — Server Framework Middleware Wrappers
// ============================================================================
//
// Adapts the universal Rollease handler (fetch Request → Response) into
// framework-native middleware shapes for Express, Fastify, Hono, and Koa.
//
// The universal handler already works natively with:
// - Next.js App Router (it IS a fetch handler)
// - Hono (via c.req.raw)
// - Bun.serve / Deno.serve
// - Cloudflare Workers
//
// These wrappers are convenience helpers for frameworks that don't speak
// the Fetch API natively.
//
// ============================================================================

import type { RolleaseHandler } from "../handler";

// ── Express ────────────────────────────────────────────────────────────────

type ExpressRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  get(name: string): string | undefined;
  body?: unknown;
  pipe?(stream: unknown): unknown;
  on?(event: string, cb: (...args: unknown[]) => void): unknown;
};
type ExpressResponse = {
  status(code: number): ExpressResponse;
  set(name: string, value: string): ExpressResponse;
  send(body: string | Buffer): void;
  end(): void;
  headersSent: boolean;
};
type ExpressNext = (err?: unknown) => void;
type ExpressMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNext
) => void;

/**
 * Wrap a Rollease universal handler as Express middleware.
 *
 * ```ts
 * import express from 'express'
 * import { toExpressMiddleware } from 'rollease/middleware'
 *
 * const handler = rl.createHandler({ contextFromRequest: ... })
 * app.use('/api/rollease', toExpressMiddleware(handler))
 * ```
 */
export function toExpressMiddleware(handler: RolleaseHandler): ExpressMiddleware {
  return async (req, res, next) => {
    try {
      const fetchReq = expressToFetchRequest(req);
      const fetchRes = await handler(fetchReq);
      await sendFetchResponse(fetchRes, res);
    } catch (err) {
      next(err);
    }
  };
}

function expressToFetchRequest(req: ExpressRequest): Request {
  const host = req.get("host") ?? "localhost";
  const protocol = req.protocol ?? "http";
  const url = `${protocol}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  const method = req.method.toUpperCase();
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";

  let body: string | undefined;
  if (hasBody && req.body) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  return new Request(url, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

async function sendFetchResponse(
  fetchRes: Response,
  res: ExpressResponse
): Promise<void> {
  res.status(fetchRes.status);
  fetchRes.headers.forEach((value, key) => {
    res.set(key, value);
  });

  if (!fetchRes.body) {
    res.end();
    return;
  }

  const text = await fetchRes.text();
  res.send(text);
}

// ── Fastify ────────────────────────────────────────────────────────────────

type FastifyRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  hostname: string;
  protocol: string;
  body?: unknown;
  raw: { url?: string };
};
type FastifyReply = {
  status(code: number): FastifyReply;
  code(statusCode: number): FastifyReply;
  headers(values: Record<string, string>): FastifyReply;
  header(name: string, value: string): FastifyReply;
  send(payload: string | Buffer): FastifyReply;
  sent: boolean;
};
type FastifyInstance = {
  all(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  addContentTypeParser(
    contentType: string,
    opts: Record<string, unknown>,
    fn: (req: unknown, body: unknown, done: (err: null, body: unknown) => void) => void
  ): void;
};

/**
 * Register a Rollease universal handler as a Fastify route.
 *
 * ```ts
 * import Fastify from 'fastify'
 * import { toFastifyPlugin } from 'rollease/middleware'
 *
 * const handler = rl.createHandler({ contextFromRequest: ... })
 * const app = Fastify()
 * toFastifyPlugin(app, '/api/rollease', handler)
 * ```
 */
export function toFastifyPlugin(
  fastify: FastifyInstance,
  basePath: string,
  handler: RolleaseHandler
): void {
  const routePath = basePath.endsWith("/")
    ? `${basePath}*`
    : `${basePath}/*`;

  fastify.all(routePath, async (req, reply) => {
    const url = `${req.protocol}://${req.hostname}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    const method = req.method.toUpperCase();
    const hasBody = method === "POST" || method === "PATCH" || method === "PUT";

    let body: string | undefined;
    if (hasBody && req.body) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const fetchReq = new Request(url, {
      method,
      headers,
      body: hasBody ? body : undefined,
    });

    const fetchRes = await handler(fetchReq);

    reply.code(fetchRes.status);
    fetchRes.headers.forEach((value, key) => {
      reply.header(key, value);
    });

    const text = await fetchRes.text();
    reply.send(text);
  });
}

// ── Hono ───────────────────────────────────────────────────────────────────

type HonoContext = {
  req: { raw: Request };
};
type HonoMiddleware = (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>;

/**
 * Wrap a Rollease universal handler as Hono middleware.
 *
 * ```ts
 * import { Hono } from 'hono'
 * import { toHonoMiddleware } from 'rollease/middleware'
 *
 * const handler = rl.createHandler({ contextFromRequest: ... })
 * app.all('/api/rollease/*', toHonoMiddleware(handler))
 * ```
 */
export function toHonoMiddleware(handler: RolleaseHandler): HonoMiddleware {
  return async (c) => {
    return handler(c.req.raw);
  };
}

// ── Koa ────────────────────────────────────────────────────────────────────

type KoaContext = {
  method: string;
  url: string;
  origin: string;
  headers: Record<string, string | string[] | undefined>;
  request: { body?: unknown };
  status: number;
  body: unknown;
  set(name: string, value: string): void;
};
type KoaNext = () => Promise<void>;
type KoaMiddleware = (ctx: KoaContext, next: KoaNext) => Promise<void>;

/**
 * Wrap a Rollease universal handler as Koa middleware.
 *
 * ```ts
 * import Koa from 'koa'
 * import { toKoaMiddleware } from 'rollease/middleware'
 *
 * const handler = rl.createHandler({ contextFromRequest: ... })
 * app.use(toKoaMiddleware(handler))
 * ```
 */
export function toKoaMiddleware(handler: RolleaseHandler): KoaMiddleware {
  return async (ctx, next) => {
    const url = `${ctx.origin}${ctx.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(ctx.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    const method = ctx.method.toUpperCase();
    const hasBody = method === "POST" || method === "PATCH" || method === "PUT";

    let body: string | undefined;
    if (hasBody && ctx.request.body) {
      body =
        typeof ctx.request.body === "string"
          ? ctx.request.body
          : JSON.stringify(ctx.request.body);
    }

    const fetchReq = new Request(url, {
      method,
      headers,
      body: hasBody ? body : undefined,
    });

    const fetchRes = await handler(fetchReq);

    ctx.status = fetchRes.status;
    fetchRes.headers.forEach((value, key) => {
      ctx.set(key, value);
    });

    ctx.body = await fetchRes.text();
  };
}
