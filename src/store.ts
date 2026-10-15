import { Redis } from '@upstash/redis';

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttl: number): Promise<void>;
  claim(key: string, token: string, ttl: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}
export function createStore(): Store {
  const redis = Redis.fromEnv();
  return {
    get: <T>(key: string) => redis.get<T>(key),
    async set(key, value, ttl) { await redis.set(key, value, { ex: ttl }); },
    async claim(key, token, ttl) { return await redis.set(key, token, { nx: true, ex: ttl }) === 'OK'; },
    async release(key, token) {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [key], [token]);
    },
  };
}
