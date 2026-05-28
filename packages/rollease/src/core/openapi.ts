// ============================================================================
// Rollease SDK — OpenAPI Spec Generator
// ============================================================================
//
// Generates an OpenAPI 3.1 specification from Rollease handler route definitions.
//
// Usage:
//
//   import { generateOpenAPISpec } from 'rollease/openapi'
//   const spec = generateOpenAPISpec({ basePath: '/api/rollease' })
//   fs.writeFileSync('openapi.json', JSON.stringify(spec, null, 2))
//
// ============================================================================

export interface OpenAPIGeneratorOptions {
  /** Base path where the handler is mounted. @default '/api/rollease' */
  basePath?: string;
  /** API title. @default 'Rollease Feature Flag API' */
  title?: string;
  /** API version. @default '0.1.0' */
  version?: string;
  /** Server URL. */
  serverUrl?: string;
  /** Include admin routes. @default true */
  includeAdmin?: boolean;
}

/**
 * Generate an OpenAPI 3.1 specification for the Rollease HTTP handler.
 */
export function generateOpenAPISpec(
  options: OpenAPIGeneratorOptions = {}
): Record<string, unknown> {
  const {
    basePath = "/api/rollease",
    title = "Rollease Feature Flag API",
    version = "0.1.0",
    serverUrl,
    includeAdmin = true,
  } = options;

  const paths: Record<string, unknown> = {};

  // ── Public routes ────────────────────────────────────────────────────────

  paths[`${basePath}/health`] = {
    get: {
      operationId: "health",
      summary: "Health check",
      tags: ["Health"],
      responses: {
        200: {
          description: "Service is healthy",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
                  ts: { type: "number" },
                },
              },
            },
          },
        },
        503: { description: "Service is unhealthy" },
      },
    },
  };

  paths[`${basePath}/flags`] = {
    get: {
      operationId: "evaluateAll",
      summary: "Evaluate all flags for the current context",
      tags: ["Evaluation"],
      parameters: [
        { name: "X-Rollease-Context", in: "header", schema: { type: "string" }, description: "Base64url-encoded JSON context" },
        { name: "X-Rollease-Client-Key", in: "header", schema: { type: "string" }, description: "Public client key" },
        { name: "context", in: "query", schema: { type: "string" }, description: "Base64url-encoded JSON context" },
      ],
      responses: {
        200: {
          description: "Evaluated flag map",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flags: { type: "object", additionalProperties: true },
                  ts: { type: "number" },
                },
              },
            },
          },
        },
        401: { description: "Invalid or missing client key" },
      },
    },
  };

  paths[`${basePath}/flags/stream`] = {
    get: {
      operationId: "streamFlags",
      summary: "SSE stream of flag evaluations",
      tags: ["Evaluation"],
      responses: {
        200: {
          description: "Server-Sent Events stream",
          content: { "text/event-stream": {} },
        },
      },
    },
  };

  paths[`${basePath}/flags/{key}`] = {
    get: {
      operationId: "evaluateFlag",
      summary: "Evaluate a single flag",
      tags: ["Evaluation"],
      parameters: [
        { name: "key", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: {
          description: "Flag evaluation result",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FlagResult" },
            },
          },
        },
        404: { description: "Flag not found" },
      },
    },
  };

  paths[`${basePath}/events`] = {
    post: {
      operationId: "trackEvents",
      summary: "Track analytics events",
      tags: ["Events"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                event: { type: "string" },
                userId: { type: "string" },
                value: { type: "number" },
                metadata: { type: "object" },
                events: { type: "array", items: { type: "object" } },
              },
              required: ["event"],
            },
          },
        },
      },
      responses: {
        204: { description: "Events recorded" },
        400: { description: "Invalid request body" },
      },
    },
  };

  // ── Admin routes ─────────────────────────────────────────────────────────

  if (includeAdmin) {
    paths[`${basePath}/admin/flags`] = {
      get: {
        operationId: "adminListFlags",
        summary: "List all flags (admin)",
        tags: ["Admin"],
        security: [{ adminAuth: [] }],
        responses: {
          200: {
            description: "Flag list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    flags: { type: "array", items: { $ref: "#/components/schemas/Flag" } },
                    total: { type: "number" },
                  },
                },
              },
            },
          },
          401: { description: "Unauthorized" },
        },
      },
      post: {
        operationId: "adminCreateFlag",
        summary: "Create a flag (admin)",
        tags: ["Admin"],
        security: [{ adminAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CreateFlagInput" } },
          },
        },
        responses: {
          201: { description: "Flag created" },
          400: { description: "Validation error" },
          401: { description: "Unauthorized" },
        },
      },
    };

    paths[`${basePath}/admin/flags/{key}`] = {
      patch: {
        operationId: "adminUpdateFlag",
        summary: "Update a flag (admin)",
        tags: ["Admin"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Flag updated" }, 401: { description: "Unauthorized" } },
      },
      delete: {
        operationId: "adminArchiveFlag",
        summary: "Archive a flag (admin)",
        tags: ["Admin"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 204: { description: "Flag archived" }, 401: { description: "Unauthorized" } },
      },
    };

    paths[`${basePath}/admin/flags/{key}/kill`] = {
      post: {
        operationId: "adminKillFlag",
        summary: "Kill switch (admin)",
        tags: ["Admin"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 204: { description: "Flag killed" } },
      },
    };

    paths[`${basePath}/admin/flags/{key}/restore`] = {
      post: {
        operationId: "adminRestoreFlag",
        summary: "Restore killed flag (admin)",
        tags: ["Admin"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 204: { description: "Flag restored" } },
      },
    };

    paths[`${basePath}/admin/flags/{key}/history`] = {
      get: {
        operationId: "adminFlagHistory",
        summary: "Get flag history (admin)",
        tags: ["Admin"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "History entries",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };

    paths[`${basePath}/admin/segments`] = {
      get: {
        operationId: "adminListSegments",
        summary: "List segments (admin)",
        tags: ["Admin"],
        responses: { 200: { description: "Segment list" } },
      },
      post: {
        operationId: "adminCreateSegment",
        summary: "Create segment (admin)",
        tags: ["Admin"],
        responses: { 201: { description: "Segment created" } },
      },
    };
  }

  // ── Components ───────────────────────────────────────────────────────────

  return {
    openapi: "3.1.0",
    info: { title, version, description: "Rollease feature flag management API" },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    paths,
    components: {
      schemas: {
        FlagResult: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: {},
            enabled: { type: "boolean" },
            variant: { type: "string", nullable: true },
            reason: { type: "string", enum: ["default", "targeting", "rollout", "kill", "prerequisite", "disabled", "error", "override", "experiment", "segment", "schedule", "percentage"] },
            ruleId: { type: "string", nullable: true },
            evaluatedAt: { type: "string", format: "date-time" },
          },
        },
        Flag: {
          type: "object",
          properties: {
            key: { type: "string" },
            type: { type: "string", enum: ["boolean", "string", "number", "json", "multivariate", "percentage"] },
            status: { type: "string", enum: ["active", "killed", "archived"] },
            enabled: { type: "boolean" },
            defaultValue: {},
            description: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        CreateFlagInput: {
          type: "object",
          required: ["key"],
          properties: {
            key: { type: "string" },
            type: { type: "string" },
            description: { type: "string" },
            enabled: { type: "boolean" },
            defaultValue: {},
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      securitySchemes: {
        adminAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Admin authentication token",
        },
        clientKey: {
          type: "apiKey",
          in: "header",
          name: "X-Rollease-Client-Key",
          description: "Public client key for browser access",
        },
      },
    },
  };
}
