// Rollease Edge Middleware — injects evaluated flags into every response so
// RSC and client components both read from a signed cookie/header (zero extra
// round-trips, no flash of unstyled content).

import { rolleaseMiddleware } from "rollease/next";
import { rl } from "./lib/rollease-edge";

export const middleware = rolleaseMiddleware(rl, {
  // Resolve the user from the request — runs at the Edge, so keep it fast.
  context: async (req) => {
    const userId = req.cookies.get("user_id")?.value;
    return { userId };
  },
  // Only inject flags on page routes, not API calls.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
