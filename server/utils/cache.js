// cache.js — Simple in-memory cache with TTL

class MemoryCache {
  constructor(defaultTtlMs = 5 * 60 * 1000) {
    this.store = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = ttlMs || this.defaultTtlMs;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  size() {
    // Only count non-expired entries
    let count = 0;
    const now = Date.now();
    for (const [, entry] of this.store) {
      if (now <= entry.expiresAt) count++;
    }
    return count;
  }
}

module.exports = new MemoryCache();
