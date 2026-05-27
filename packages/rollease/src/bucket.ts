/**
 * 32-bit MurmurHash3 implementation in TypeScript.
 * Provides fast, consistent hashing for flag percentage rollouts.
 */
export function murmurhash3_32(key: string, seed: number = 0): number {
  let h1 = seed;
  const remainder = key.length & 3;
  const bytes = key.length - remainder;
  let i = 0;

  // Use Math.imul to perform 32-bit integer multiplication (correct handling of overflow)
  while (i < bytes) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    i += 4;

    k1 = Math.imul(k1, 0xcc9e2d51);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, 0x1b873593);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  let k1 = 0;
  switch (remainder) {
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
      // fallthrough
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
      // fallthrough
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;
      k1 = Math.imul(k1, 0xcc9e2d51);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, 0x1b873593);
      h1 ^= k1;
  }

  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

/**
 * Returns a bucket value between 0 and 99 (inclusive) for a given user and flag.
 */
export function getBucket(userId: string, flagId: string, salt = ""): number {
  const hash = murmurhash3_32(`${userId}:${flagId}:${salt}`);
  return hash % 100;
}
