type CacheEntry<T> = {
  value: Promise<T>;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

export async function withCache<T>(
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.value as Promise<T>;
  }

  const value = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, {
    value,
    expiresAt: now + ttlMs,
  });

  return value;
}
