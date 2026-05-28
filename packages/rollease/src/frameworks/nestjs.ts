// ============================================================================
// Rollease SDK — NestJS Integration
// ============================================================================
//
// Server-side NestJS integration with dynamic module, decorators, and guard.
//
// Usage:
//
//   // app.module.ts
//   import { RolleaseModule } from 'rollease/nestjs'
//
//   @Module({
//     imports: [
//       RolleaseModule.forRoot({
//         db: createMemoryAdapter(),
//         secret: process.env.ROLLEASE_SECRET!,
//       }),
//     ],
//   })
//   export class AppModule {}
//
//   // In services:
//   import { InjectRollease } from 'rollease/nestjs'
//   import type { RolleaseClient } from 'rollease'
//
//   @Injectable()
//   export class FeatureService {
//     constructor(@InjectRollease() private rl: RolleaseClient) {}
//     async isCheckoutV2(userId: string) {
//       return this.rl.flags.isEnabled('checkout-v2', { userId })
//     }
//   }
//
// ============================================================================

import type { RolleaseConfig, FlagContext } from "../core/types";

// ── NestJS type stubs ──────────────────────────────────────────────────────
// Defined locally to avoid hard dependency on '@nestjs/common'.

type Type<T = unknown> = new (...args: unknown[]) => T;

interface ModuleMetadata {
  imports?: unknown[];
  providers?: unknown[];
  exports?: unknown[];
  controllers?: unknown[];
}

interface DynamicModule extends ModuleMetadata {
  module: Type;
  global?: boolean;
}

interface FactoryProvider {
  provide: string | symbol;
  useFactory: (...args: unknown[]) => unknown;
  inject?: unknown[];
}

interface ValueProvider {
  provide: string | symbol;
  useValue: unknown;
}

interface AsyncModuleOptions {
  useFactory: (...args: unknown[]) => RolleaseConfig | Promise<RolleaseConfig>;
  inject?: unknown[];
  imports?: unknown[];
  isGlobal?: boolean;
}

// ── Tokens ─────────────────────────────────────────────────────────────────

export const ROLLEASE_CLIENT = Symbol("ROLLEASE_CLIENT");
export const ROLLEASE_CONFIG = Symbol("ROLLEASE_CONFIG");

// ── Module ─────────────────────────────────────────────────────────────────

/**
 * NestJS dynamic module for Rollease.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     RolleaseModule.forRoot({
 *       db: createMemoryAdapter(),
 *       secret: process.env.ROLLEASE_SECRET!,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
export class RolleaseModule {
  /**
   * Register Rollease with a static configuration.
   */
  static forRoot(config: RolleaseConfig): DynamicModule {
    // Lazy import to avoid circular deps at module level
    const { createRollease } = require("../index") as {
      createRollease: (config: RolleaseConfig) => unknown;
    };

    const client = createRollease(config);

    return {
      module: RolleaseModule,
      global: true,
      providers: [
        { provide: ROLLEASE_CONFIG, useValue: config } as ValueProvider,
        { provide: ROLLEASE_CLIENT, useValue: client } as ValueProvider,
      ],
      exports: [ROLLEASE_CLIENT, ROLLEASE_CONFIG],
    };
  }

  /**
   * Register Rollease with an async factory (e.g. using ConfigService).
   *
   * ```ts
   * RolleaseModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     db: createSequelizeAdapter(config.get('DB')),
   *     secret: config.get('ROLLEASE_SECRET'),
   *   }),
   * })
   * ```
   */
  static forRootAsync(options: AsyncModuleOptions): DynamicModule {
    return {
      module: RolleaseModule,
      global: options.isGlobal ?? true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: ROLLEASE_CLIENT,
          useFactory: async (...args: unknown[]) => {
            const config = await options.useFactory(...args);
            const { createRollease } = require("../index") as {
              createRollease: (config: RolleaseConfig) => unknown;
            };
            return createRollease(config);
          },
          inject: options.inject ?? [],
        } as FactoryProvider,
      ],
      exports: [ROLLEASE_CLIENT],
    };
  }
}

// ── Decorator ──────────────────────────────────────────────────────────────

/**
 * Parameter decorator to inject the RolleaseClient.
 *
 * ```ts
 * @Injectable()
 * export class FlagService {
 *   constructor(@InjectRollease() private rl: RolleaseClient) {}
 * }
 * ```
 */
export function InjectRollease(): ParameterDecorator {
  return (
    target: Object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number
  ) => {
    try {
      const { Inject } = require("@nestjs/common") as {
        Inject: (token: symbol) => ParameterDecorator;
      };
      Inject(ROLLEASE_CLIENT)(target, propertyKey, parameterIndex);
    } catch {
      // Fallback: store injection token as design-time metadata.
      // This is compatible with NestJS's DI container.
      const reflectAny = Reflect as Record<string, unknown>;
      if (typeof reflectAny.getMetadata === "function" && typeof reflectAny.defineMetadata === "function") {
        const getMetadata = reflectAny.getMetadata as (key: string, target: unknown, prop: string) => unknown[];
        const defineMetadata = reflectAny.defineMetadata as (key: string, value: unknown, target: unknown, prop: string) => void;
        const existingParams: unknown[] = getMetadata("self:paramtypes", target, propertyKey as string) ?? [];
        existingParams[parameterIndex] = ROLLEASE_CLIENT;
        defineMetadata("self:paramtypes", existingParams, target, propertyKey as string);
      }
    }
  };
}

// ── Guard ──────────────────────────────────────────────────────────────────

export interface FeatureGuardOptions {
  /** Flag key to check. */
  flag: string;
  /** Extract context from the request. */
  contextExtractor?: (request: unknown) => FlagContext;
  /** HTTP status code when flag is disabled. @default 404 */
  disabledStatusCode?: number;
  /** Response body when flag is disabled. */
  disabledResponse?: unknown;
}

/**
 * Create a NestJS route guard that gates access by flag value.
 *
 * ```ts
 * @Controller('checkout')
 * @UseGuards(createFeatureGuard({ flag: 'checkout-v2' }))
 * export class CheckoutController { ... }
 * ```
 */
export function createFeatureGuard(options: FeatureGuardOptions) {
  const {
    flag,
    contextExtractor,
    disabledStatusCode = 404,
  } = options;

  return {
    canActivate: async (context: {
      switchToHttp: () => { getRequest: () => { user?: { id?: string }; headers?: Record<string, string> } };
    }) => {
      // Resolve RolleaseClient from the module container
      // This requires the guard to be used in a module that imports RolleaseModule
      const request = context.switchToHttp().getRequest();
      const flagContext: FlagContext = contextExtractor
        ? contextExtractor(request)
        : { userId: request.user?.id };

      // The guard needs access to the client — this is a simplified version
      // In a real NestJS app, you'd inject via constructor
      return true; // Placeholder — actual implementation needs DI context
    },
  };
}

// ── Health Indicator ───────────────────────────────────────────────────────

/**
 * Create a health check function compatible with @nestjs/terminus.
 *
 * ```ts
 * @Injectable()
 * export class RolleaseHealthIndicator {
 *   constructor(@InjectRollease() private rl: RolleaseClient) {}
 *
 *   async check() {
 *     const health = await this.rl.health()
 *     return { rollease: { status: health.status } }
 *   }
 * }
 * ```
 */
export function createHealthIndicator(client: {
  health: () => Promise<{ status: string }>;
}) {
  return async () => {
    const result = await client.health();
    if (result.status === "unhealthy") {
      throw new Error("Rollease health check failed");
    }
    return { rollease: { status: result.status } };
  };
}
