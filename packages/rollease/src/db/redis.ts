// ============================================================================
// Rollease SDK - Redis Cache Adapter
// ============================================================================

import type {
  CacheAdapter,
  InvalidationBus,
  InvalidationListener,
  InvalidationMessage,
} from "./adapter";

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

type RedisPubSubClientLike = RedisClientLike & {
  publish?: (channel: string, message: string) => Promise<unknown>;
  subscribe?: (
    channel: string,
    listener: (message: string) => void
  ) => Promise<unknown>;
  unsubscribe?: (channel: string) => Promise<unknown>;
  duplicate?: () => RedisPubSubClientLike;
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

    // Escape Redis glob special characters in the prefix portion to avoid
    // unintended pattern matching (e.g. prefix containing `[` or `*`).
    const escapedPrefix = this.keyPrefix.replace(/([*?[\]\\])/g, "\\$1");
    const fullPattern = `${escapedPrefix}${pattern}`;
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

export interface RedisInvalidationBusOptions {
  /** Existing redis v4 client. If omitted, the bus lazy-creates one. */
  client?: RedisPubSubClientLike;
  /** Optional dedicated subscriber client. Defaults to client.duplicate() when available. */
  subscriber?: RedisPubSubClientLike;
  /** Redis connection URL used when client is omitted. */
  url?: string;
  /** Pub/sub channel name. @default 'rollease:invalidation' */
  channel?: string;
  /** Automatically connect before commands. Defaults to true. */
  autoConnect?: boolean;
}

export class RedisInvalidationBus implements InvalidationBus {
  private publisher?: RedisPubSubClientLike;
  private subscriber?: RedisPubSubClientLike;
  private ownsClients: boolean;
  private url?: string;
  private channel: string;
  private autoConnect: boolean;
  private connected = false;
  private subscribed = false;
  private connectPromise?: Promise<void>;
  private listeners = new Set<InvalidationListener>();

  constructor(options: RedisInvalidationBusOptions = {}) {
    this.publisher = options.client;
    this.subscriber = options.subscriber;
    this.ownsClients = !options.client;
    this.url = options.url;
    this.channel = options.channel ?? "rollease:invalidation";
    this.autoConnect = options.autoConnect ?? true;
  }

  async publish(message: InvalidationMessage): Promise<void> {
    const client = await this.getPublisher();
    if (!client.publish) {
      throw new Error("Redis client must support publish() for invalidation");
    }
    await client.publish(
      this.channel,
      JSON.stringify({ ...message, ts: message.ts ?? Date.now() })
    );
  }

  async subscribe(listener: InvalidationListener): Promise<() => void> {
    this.listeners.add(listener);
    await this.ensureSubscribed();
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    if (this.subscriber?.unsubscribe && this.subscribed) {
      await this.subscriber.unsubscribe(this.channel);
    }
    if (!this.ownsClients) return;
    await closeRedisClient(this.subscriber);
    if (this.publisher !== this.subscriber) {
      await closeRedisClient(this.publisher);
    }
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    const subscriber = await this.getSubscriber();
    if (!subscriber.subscribe) {
      throw new Error("Redis client must support subscribe() for invalidation");
    }
    await subscriber.subscribe(this.channel, (raw) => {
      let parsed: InvalidationMessage;
      try {
        parsed = JSON.parse(raw) as InvalidationMessage;
      } catch {
        return;
      }
      for (const listener of this.listeners) {
        void listener(parsed);
      }
    });
    this.subscribed = true;
  }

  private async getPublisher(): Promise<RedisPubSubClientLike> {
    if (!this.publisher) {
      const redisModule = await importRedisModule();
      this.publisher = redisModule.createClient(
        this.url ? { url: this.url } : undefined
      ) as RedisPubSubClientLike;
    }
    await this.connectClients();
    return this.publisher;
  }

  private async getSubscriber(): Promise<RedisPubSubClientLike> {
    if (!this.subscriber) {
      const publisher = await this.getPublisher();
      this.subscriber = publisher.duplicate
        ? publisher.duplicate()
        : publisher;
      if (
        this.autoConnect &&
        this.subscriber !== publisher &&
        this.subscriber.connect &&
        this.subscriber.isOpen !== true
      ) {
        await this.subscriber.connect();
      }
    }
    await this.connectClients();
    return this.subscriber;
  }

  private async connectClients(): Promise<void> {
    if (!this.autoConnect || this.connected) return;
    this.connectPromise ??= (async () => {
      if (this.publisher?.connect && this.publisher.isOpen !== true) {
        await this.publisher.connect();
      }
      if (
        this.subscriber &&
        this.subscriber !== this.publisher &&
        this.subscriber.connect &&
        this.subscriber.isOpen !== true
      ) {
        await this.subscriber.connect();
      }
      this.connected = true;
    })();
    await this.connectPromise;
  }
}

export function createRedisInvalidationBus(
  options: RedisInvalidationBusOptions = {}
): RedisInvalidationBus {
  return new RedisInvalidationBus(options);
}

async function closeRedisClient(client: RedisPubSubClientLike | undefined): Promise<void> {
  if (!client) return;
  if (client.quit) {
    await client.quit();
    return;
  }
  if (client.disconnect) {
    await client.disconnect();
  }
}

async function importRedisModule(): Promise<{
  createClient: (options?: { url?: string }) => RedisPubSubClientLike;
}> {
  const moduleName = "redis";
  return (await import(moduleName)) as {
    createClient: (options?: { url?: string }) => RedisPubSubClientLike;
  };
}
