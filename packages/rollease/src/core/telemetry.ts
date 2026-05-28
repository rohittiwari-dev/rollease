// ============================================================================
// Rollease SDK — Telemetry Adapter
//
// Plug-in interface for OpenTelemetry and custom tracing.  Zero overhead when
// no adapter is configured — every call site guards with `if (telemetry)`.
//
// Usage with @opentelemetry/api:
//
//   import { trace } from '@opentelemetry/api'
//   import { createOtelAdapter } from 'rollease/telemetry'
//
//   const rl = createRollease({
//     db, secret,
//     telemetry: createOtelAdapter(trace.getTracer('rollease')),
//   })
// ============================================================================

import type { TelemetryAdapter, TelemetrySpan } from "./types";

export type { TelemetryAdapter, TelemetrySpan };

// ── No-op span (returned when telemetry is disabled) ─────────────────────────

export const noopSpan: TelemetrySpan = {
  setAttribute() {},
  end() {},
};

// ── OpenTelemetry adapter factory ─────────────────────────────────────────────

/**
 * Minimal interface we need from @opentelemetry/api Tracer — avoids a hard dep.
 * Compatible with the real `Tracer` interface from @opentelemetry/api ≥1.0.
 */
interface OtelTracerLike {
  startActiveSpan<F extends (span: OtelSpanLike) => unknown>(
    name: string,
    fn: F
  ): ReturnType<F>;
  startSpan(name: string, options?: Record<string, unknown>): OtelSpanLike;
}

interface OtelSpanLike {
  setAttribute(key: string, value: unknown): this;
  setStatus(status: { code: number; message?: string }): this;
  end(): void;
}

/**
 * Create a Rollease TelemetryAdapter backed by an OpenTelemetry Tracer.
 *
 * ```ts
 * import { trace } from '@opentelemetry/api'
 * createOtelAdapter(trace.getTracer('rollease', '1.0'))
 * ```
 */
export function createOtelAdapter(tracer: OtelTracerLike): TelemetryAdapter {
  return {
    startSpan(name, attrs) {
      const otelSpan = tracer.startSpan(name);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          otelSpan.setAttribute(k, v);
        }
      }
      const span: TelemetrySpan = {
        setAttribute(key, value) {
          otelSpan.setAttribute(key, value);
        },
        end(status, error) {
          if (status === "error") {
            // SpanStatusCode.ERROR = 2 in @opentelemetry/api
            otelSpan.setStatus({ code: 2, message: error?.message });
          } else {
            // SpanStatusCode.OK = 1
            otelSpan.setStatus({ code: 1 });
          }
          otelSpan.end();
        },
      };
      return span;
    },
  };
}

/**
 * Create a simple console-logging TelemetryAdapter — useful for debugging
 * without a full OTel setup.
 */
export function createConsoleAdapter(
  prefix = "[rollease-trace]"
): TelemetryAdapter {
  return {
    startSpan(name, attrs) {
      const start = Date.now();
      console.debug(`${prefix} → ${name}`, attrs ?? {});
      return {
        setAttribute() {},
        end(status, error) {
          const ms = Date.now() - start;
          if (status === "error") {
            console.debug(`${prefix} ✗ ${name} (${ms}ms)`, error?.message);
          } else {
            console.debug(`${prefix} ✓ ${name} (${ms}ms)`);
          }
        },
      };
    },
  };
}
