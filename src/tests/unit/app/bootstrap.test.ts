/**
 * Unit tests for app/bootstrap.ts infrastructure startup.
 *
 * Regression: repositories use the module-level postgres query() helper, so
 * bootstrap must eagerly initialise and validate the Postgres pool before the
 * first live trade tries to save to DB.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireEnv = vi.fn((name: string) => {
  if (name === 'WALLET_SECRET_KEY') return Buffer.alloc(64, 7).toString('base64');
  if (name === 'HELIUS_API_KEY') return 'helius-key';
  if (name === 'DATABASE_URL') return 'postgresql://pumpfun:pumpfun123@localhost:5432/pumpfun';
  if (name === 'REDIS_URL') return 'redis://localhost:6379';
  throw new Error(`missing ${name}`);
});
const mockOptionalEnv = vi.fn((_name: string, fallback: string) => fallback);

interface MockHealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

const mockPostgresHealthCheck = vi.fn<() => Promise<MockHealthCheckResult>>(async () => ({ ok: true, latencyMs: 1 }));
const mockInfo = vi.fn();
const mockError = vi.fn();
const mockPgPoolGetter = vi.fn(() => ({}));
const mockRedisGetter = vi.fn(() => ({}));
const mockRpcHealth = vi.fn(() => [{ name: 'primary', healthy: true }]);
const mockSignerPubkey = vi.fn(() => 'wallet-pubkey');
const mockKillSwitchState = vi.fn(() => ({ killed: false }));

vi.mock('../../../core/config/env.js', () => ({
  requireEnv: mockRequireEnv,
  optionalEnv: mockOptionalEnv,
}));

vi.mock('../../../storage/postgres/postgresClient.js', () => ({
  healthCheck: mockPostgresHealthCheck,
}));

vi.mock('../../../telemetry/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: mockInfo, error: mockError })),
}));

vi.mock('../../../app/container.js', () => ({
  ServiceContainer: class MockServiceContainer {
    get pgPool() {
      return mockPgPoolGetter();
    }

    get redis() {
      return mockRedisGetter();
    }

    get rpcPool() {
      return { getHealthStatus: mockRpcHealth };
    }

    get signer() {
      return { getPublicKey: () => ({ toBase58: mockSignerPubkey }) };
    }

    get killSwitch() {
      return { getState: mockKillSwitchState };
    }
  },
}));

describe('bootstrap postgres startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostgresHealthCheck.mockImplementation(async () => ({ ok: true, latencyMs: 1 }));
  });

  it('eagerly creates and health-checks Postgres before startup completes', async () => {
    const { bootstrap } = await import('../../../app/bootstrap.js');

    await bootstrap();

    expect(mockPgPoolGetter).toHaveBeenCalledTimes(1);
    expect(mockPostgresHealthCheck).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith('  PostgreSQL pool ready', { latencyMs: 1 });
  });

  it('refuses to start when Postgres health check fails', async () => {
    mockPostgresHealthCheck.mockImplementation(async () => ({ ok: false, latencyMs: 5, error: 'connect ECONNREFUSED' }));
    const { bootstrap } = await import('../../../app/bootstrap.js');

    await expect(bootstrap()).rejects.toThrow('connect ECONNREFUSED');
    expect(mockError).toHaveBeenCalledWith(
      '  PostgreSQL unavailable — refusing to start without trade persistence',
      { error: 'connect ECONNREFUSED' },
    );
  });
});
