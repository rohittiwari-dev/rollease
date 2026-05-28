import { describe, expect, it } from "vitest";
import {
  RedisCacheAdapter,
  RedisInvalidationBus,
  createRedisCache,
  createRedisInvalidationBus,
} from "../src/db/redis";

class FakeRedisClient {
  isOpen = false;
  store = new Map<string, string>();
  connected = 0;
  closed = 0;
  listeners = new Map<string, Set<(message: string) => void>>();

  async connect() {
    this.connected += 1;
    this.isOpen = true;
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.store.set(key, value);
  }

  async del(keyOrKeys: string | string[]) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const key of keys) {
      this.store.delete(key);
    }
  }

  async *scanIterator(options?: { MATCH?: string }) {
    const matcher = globMatcher(options?.MATCH ?? "*");
    for (const key of this.store.keys()) {
      if (matcher(key)) {
        yield key;
      }
    }
  }

  async quit() {
    this.closed += 1;
    this.isOpen = false;
  }

  duplicate() {
    return this;
  }

  async publish(channel: string, message: string) {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener(message);
    }
  }

  async subscribe(channel: string, listener: (message: string) => void) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(listener);
  }

  async unsubscribe(channel: string) {
    this.listeners.delete(channel);
  }
}

describe("RedisCacheAdapter", () => {
  it("should support get, set, del, delPattern, and close", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCacheAdapter({
      client,
      keyPrefix: "test:",
      scanCount: 2,
    });

    await cache.set("a", "1", 1000);
    await cache.set("feature:a", "2", 1000);
    await cache.set("feature:b", "3", 1000);

    expect(client.connected).toBe(1);
    expect(await cache.get("a")).toBe("1");

    await cache.del("a");
    expect(await cache.get("a")).toBeNull();

    await cache.delPattern("feature:*");
    expect(await cache.get("feature:a")).toBeNull();
    expect(await cache.get("feature:b")).toBeNull();

    await cache.close();
    expect(client.closed).toBe(0);
  });

  it("should expose factory helper", () => {
    expect(createRedisCache()).toBeInstanceOf(RedisCacheAdapter);
  });

  it("publishes and subscribes invalidation messages", async () => {
    const client = new FakeRedisClient();
    const bus = new RedisInvalidationBus({ client, channel: "rl:test" });
    const seen: unknown[] = [];

    await bus.subscribe((message) => {
      seen.push(message);
    });
    await bus.publish({ scope: "flag", key: "checkout" });

    expect(seen).toMatchObject([{ scope: "flag", key: "checkout" }]);
    expect(createRedisInvalidationBus()).toBeInstanceOf(RedisInvalidationBus);
    await bus.close();
  });
});

function globMatcher(pattern: string): (value: string) => boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
        .replace(/\\\*/g, ".*")
        .replace(/\\\?/g, ".") +
      "$"
  );
  return (value) => regex.test(value);
}
