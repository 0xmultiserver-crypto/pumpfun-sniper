/**
 * Redis client wrapper.
 *
 * Persistence only. NEVER business logic.
 * Connection management + health check.
 */

import { Redis } from 'ioredis';

/** Redis client configuration */
export interface RedisClientConfig {
  readonly url: string;
  readonly maxRetriesPerRequest: number;
  readonly lazyConnect: boolean;
}

/** Default Redis config */
const DEFAULT_REDIS_CONFIG: Omit<RedisClientConfig, 'url'> = {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
} as const;

/**
 * Create a configured Redis client instance.
 * Caller is responsible for connect() and quit().
 */
export function createRedisClient(url: string, overrides?: Partial<RedisClientConfig>): Redis {
  const config = { ...DEFAULT_REDIS_CONFIG, ...overrides };

  const client = new Redis(url, {
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    lazyConnect: config.lazyConnect,
    retryStrategy(times: number): number | null {
      if (times > 10) {
        return null; // Stop retrying after 10 attempts
      }
      return Math.min(times * 200, 5_000);
    },
  });

  return client;
}

/** Check if Redis is connected and responsive */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    const result = await client.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/** Gracefully disconnect Redis */
export async function disconnectRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    // Force disconnect if quit fails
    client.disconnect();
  }
}
