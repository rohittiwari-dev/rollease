// ============================================================================
// Rollease SDK — RBAC (Role-Based Access Control)
// ============================================================================
//
// Pluggable RBAC system with opinionated presets.
//
// Usage:
//
//   import { createDefaultRBACPolicy, createRBACHook } from 'rollease/rbac'
//
//   const policy = createDefaultRBACPolicy({
//     'user-admin': 'admin',
//     'user-editor': 'editor',
//     'user-viewer': 'viewer',
//   })
//
//   const rl = createRollease({
//     ...,
//     hooks: { onBeforeMutation: createRBACHook(policy) },
//   })
//
// ============================================================================

// ── Roles & Permissions ────────────────────────────────────────────────────

export type RolleaseRole = "viewer" | "editor" | "admin" | "owner";

export type RolleasePermission =
  | "flag.read"
  | "flag.create"
  | "flag.update"
  | "flag.delete"
  | "flag.kill"
  | "flag.restore"
  | "flag.lock"
  | "rule.manage"
  | "rollout.manage"
  | "segment.manage"
  | "release.create"
  | "release.deploy"
  | "release.rollback"
  | "release.approve"
  | "release.reject"
  | "webhook.manage"
  | "tag.manage"
  | "admin.full";

// ── Default Permission Matrix ──────────────────────────────────────────────

const DEFAULT_PERMISSIONS: Record<RolleaseRole, Set<RolleasePermission>> = {
  viewer: new Set(["flag.read"]),
  editor: new Set([
    "flag.read",
    "flag.create",
    "flag.update",
    "flag.kill",
    "flag.restore",
    "flag.lock",
    "rule.manage",
    "rollout.manage",
    "tag.manage",
    "segment.manage",
    "release.create",
    "release.approve",
    "release.reject",
  ]),
  admin: new Set([
    "flag.read",
    "flag.create",
    "flag.update",
    "flag.delete",
    "flag.kill",
    "flag.restore",
    "flag.lock",
    "rule.manage",
    "rollout.manage",
    "tag.manage",
    "segment.manage",
    "release.create",
    "release.deploy",
    "release.rollback",
    "release.approve",
    "release.reject",
    "webhook.manage",
  ]),
  owner: new Set([
    "flag.read",
    "flag.create",
    "flag.update",
    "flag.delete",
    "flag.kill",
    "flag.restore",
    "flag.lock",
    "rule.manage",
    "rollout.manage",
    "tag.manage",
    "segment.manage",
    "release.create",
    "release.deploy",
    "release.rollback",
    "release.approve",
    "release.reject",
    "webhook.manage",
    "admin.full",
  ]),
};

// ── Policy Interface ───────────────────────────────────────────────────────

export interface RolleaseRBACPolicy {
  /** Check if an actor has a specific permission. */
  check(
    actor: { id?: string; role?: string; roles?: string[] } | undefined,
    permission: RolleasePermission,
    resource?: { flagKey?: string; environment?: string }
  ): boolean | Promise<boolean>;
}

// ── Action → Permission Mapping ────────────────────────────────────────────

const ACTION_PERMISSION_MAP: Record<string, RolleasePermission> = {
  "flag.created": "flag.create",
  "flag.updated": "flag.update",
  "flag.deleted": "flag.delete",
  "flag.killed": "flag.kill",
  "flag.restored": "flag.restore",
  "flag.locked": "flag.lock",
  "flag.unlocked": "flag.lock",
  "flag.archived": "flag.delete",
  "flag.cloned": "flag.create",
  "rule.added": "rule.manage",
  "rule.updated": "rule.manage",
  "rule.removed": "rule.manage",
  "rule.reordered": "rule.manage",
  "rollout.set": "rollout.manage",
  "segment.created": "segment.manage",
  "segment.updated": "segment.manage",
  "segment.deleted": "segment.manage",
  "release.created": "release.create",
  "release.deployed": "release.deploy",
  "release.rolled_back": "release.rollback",
  "release.approved": "release.approve",
  "release.rejected": "release.reject",
  "tags.added": "tag.manage",
  "tags.removed": "tag.manage",
};

// ── Default Policy Factory ─────────────────────────────────────────────────

/**
 * Create a default RBAC policy from a user ID → role mapping.
 *
 * ```ts
 * const policy = createDefaultRBACPolicy({
 *   'user-admin-id': 'admin',
 *   'user-editor-id': 'editor',
 *   'user-viewer-id': 'viewer',
 * })
 * ```
 */
export function createDefaultRBACPolicy(
  roleMap: Record<string, RolleaseRole>,
  opts?: {
    /** Custom permission matrix (merged with defaults). */
    permissions?: Partial<Record<RolleaseRole, RolleasePermission[]>>;
    /** Default role for unknown users. @default undefined (deny all) */
    defaultRole?: RolleaseRole;
  }
): RolleaseRBACPolicy {
  // Build permission matrix
  const permMatrix = new Map<RolleaseRole, Set<RolleasePermission>>();
  for (const [role, perms] of Object.entries(DEFAULT_PERMISSIONS)) {
    permMatrix.set(role as RolleaseRole, new Set(perms));
  }
  if (opts?.permissions) {
    for (const [role, perms] of Object.entries(opts.permissions)) {
      const existing = permMatrix.get(role as RolleaseRole) ?? new Set();
      for (const perm of perms!) {
        existing.add(perm);
      }
      permMatrix.set(role as RolleaseRole, existing);
    }
  }

  return {
    check(actor, permission) {
      if (!actor) return false;

      // Resolve role(s)
      const roles: RolleaseRole[] = [];
      if (actor.role) roles.push(actor.role as RolleaseRole);
      if (actor.roles) {
        for (const r of actor.roles) {
          roles.push(r as RolleaseRole);
        }
      }
      if (actor.id && roleMap[actor.id]) {
        roles.push(roleMap[actor.id]);
      }
      if (roles.length === 0 && opts?.defaultRole) {
        roles.push(opts.defaultRole);
      }

      // Check if any role grants the permission
      for (const role of roles) {
        const perms = permMatrix.get(role);
        if (perms?.has(permission) || perms?.has("admin.full")) {
          return true;
        }
      }

      return false;
    },
  };
}

// ── Hook Factory ───────────────────────────────────────────────────────────

/**
 * Create a `RolleaseHooks.onBeforeMutation` hook from an RBAC policy.
 *
 * ```ts
 * const rl = createRollease({
 *   hooks: { onBeforeMutation: createRBACHook(policy) },
 * })
 * ```
 */
export function createRBACHook(
  policy: RolleaseRBACPolicy
): (action: string, flagKey: string | undefined, actor: unknown) => Promise<void> | void {
  return async (action, flagKey, actor) => {
    const permission = ACTION_PERMISSION_MAP[action];
    if (!permission) return; // Unknown action — allow by default

    const actorObj = actor as { id?: string; role?: string; roles?: string[] } | undefined;
    const allowed = await policy.check(actorObj, permission, { flagKey });

    if (!allowed) {
      const actorId = actorObj?.id ?? "anonymous";
      throw new Error(
        `[Rollease RBAC] Actor "${actorId}" does not have permission "${permission}" for action "${action}"${
          flagKey ? ` on flag "${flagKey}"` : ""
        }`
      );
    }
  };
}

/**
 * Create an `adminAuth` function for `RolleaseHandlerOptions` from an RBAC policy.
 *
 * The returned function returns `true` when the extracted actor has at least
 * `flag.create` permission (i.e. editor or above). Individual operation
 * permissions are enforced by the `onBeforeMutation` hook; this gate prevents
 * unauthenticated callers from reaching admin routes at all.
 *
 * ```ts
 * const handler = rl.createHandler({
 *   adminAuth: createRBACAdminAuth(policy, extractActorFromReq),
 * })
 * ```
 */
export function createRBACAdminAuth(
  policy: RolleaseRBACPolicy,
  extractActor: (req: Request) => { id?: string; role?: string; roles?: string[] } | undefined | Promise<{ id?: string; role?: string; roles?: string[] } | undefined>
): (req: Request) => Promise<boolean> {
  return async (req) => {
    const actor = await extractActor(req);
    if (!actor) return false;
    // Admin routes require at least flag.create (editor+). Viewers are denied.
    return policy.check(actor, "flag.create") as boolean | Promise<boolean> as Promise<boolean>;
  };
}
