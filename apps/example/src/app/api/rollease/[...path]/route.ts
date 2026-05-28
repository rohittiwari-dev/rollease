// Universal Rollease HTTP handler — mounted at /api/rollease/*.
//
// The handler exposes:
//   GET  /api/rollease/health          — health probe
//   GET  /api/rollease/flags           — evaluate all flags for the caller
//   GET  /api/rollease/flags/stream    — SSE stream of flag changes
//   GET  /api/rollease/flags/:key      — evaluate a single flag
//   POST /api/rollease/events          — client-side impression sink
//   GET  /api/rollease/admin/flags     — list all flags (requires admin token)
//   POST /api/rollease/admin/flags     — create a flag
//   PATCH/DELETE /api/rollease/admin/flags/:key

import { rl } from "@/lib/rollease";
import { cookies } from "next/headers";

// Resolve the evaluation context from the incoming request.
// Replace this with your real auth logic (e.g. decode a session cookie).
async function contextFromRequest(req: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("user_id")?.value ?? req.headers.get("x-user-id") ?? undefined;
  const region = req.headers.get("cf-ipcountry") ?? undefined;
  return { userId, attributes: { region } };
}

const handler = rl.createHandler({
  contextFromRequest,
  adminAuth: async (req) =>
    req.headers.get("x-admin-token") === process.env.ADMIN_TOKEN,
  cors: true,
  basePath: "/api/rollease",
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
