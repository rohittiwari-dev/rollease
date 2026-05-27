// ============================================================================
// Rollease SDK - Redis Cache Adapter
// ============================================================================

import type { CacheAdapter } from "./adapter";

type RedisClientLike = {
  isOpen?: boolean;
  connect?: () => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options?: { PX?: number; EX?: number }
  ) => Promise<unknown>;
  del: (key: string | string[]) => Promise<unknown>;
  scanIterator?: (options?: {
    MATCH?: string;
    COUNT?: number;
  }) => AsyncIterable<string>;
  quit?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown> | unknown;
};

export interface RedisCacheAdapterOptions {
  /** Existing redis v4 client. If omitted, the adapter lazy-creates one. */
  client?: RedisClientLike;
  /** Redis connection URL used when client is omitted. */
  url?: string;
  /** Optional prefix for every cache key. */
  keyPrefix?: string;
  /** Automatically connect before commands. Defaults to true. */
  autoConnect?: boolean;
  /** SCAN batch size for delPattern. Defaults to 100. */
  scanCount?: number;
}

export class RedisCacheAdapter implements CacheAdapter {
  private client?: RedisClientLike;
  private ownsClient: boolean;
  private keyPrefix: string;
  private autoConnect: boolean;
  private scanCount: number;
  private connectPromise?: Promise<void>;
  private connected = false;
  private url?: string;

  constructor(options: RedisCacheAdapterOptions = {}) {
    this.client = options.client;
    this.ownsClient = !options.client;
    this.url = options.url;
    this.keyPrefix = options.keyPrefix ?? "";
    this.autoConnect = options.autoConnect ?? true;
    this.scanCount = options.scanCount ?? 100;
  }

  async get(key: string): Promise<string | null> {
    const client = await this.getClient();
    return client.get(this.key(key));
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const client = await this.getClient();
    const normalizedTtl = Math.max(1, Math.ceil(ttlMs));
    await client.set(this.key(key), value, { PX: normalizedTtl });
  }

  async del(key: string): Promise<void> {
    const client = await this.getClient();
    await client.del(this.key(key));
  }

  async delPattern(pattern: string): Promise<void> {
    const client = await this.getClient();
    if (!client.scanIterator) {
      throw new Error("Redis client must support scanIterator() for delPattern()");
    }

    const fullPattern = this.key(pattern);
    const batch: string[] = [];
    for await (const key of client.scanIterator({
      MATCH: fullPattern,
      COUNT: this.scanCount,
    })) {
      batch.push(key);
      if (batch.length >= this.scanCount) {
        await client.del(batch.splice(0, batch.length));
      }
    }

    if (batch.length > 0) {
      await client.del(batch);
    }
  }

  async close(): Promise<void> {
    if (!this.client || !this.ownsClient) return;

    if (this.client.quit) {
      await this.client.quit();
      return;
    }

    if (this.client.disconnect) {
      await this.client.disconnect();
    }
  }

  private async getClient(): Promise<RedisClientLike> {
    if (!this.client) {
      const moduleName = "redis";
      const redisModule = (await import(moduleName)) as {
        createClient: (options?: { url?: string }) => RedisClientLike;
      };
      this.client = redisModule.createClient(
        this.url ? { url: this.url } : undefined
      );
    }

    if (
      this.autoConnect &&
      this.client.connect &&
      !this.connected &&
      this.client.isOpen !== true
    ) {
      this.connectPromise ??= this.client.connect().then(() => {
        this.connected = true;
      });
      await this.connectPromise;
    }

    return this.client;
  }

  private key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

export function createRedisCache(
  options: RedisCacheAdapterOptions = {}
): RedisCacheAdapter {
  return new RedisCacheAdapter(options);
}
