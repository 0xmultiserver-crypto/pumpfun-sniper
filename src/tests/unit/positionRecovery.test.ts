import { describe, expect, it } from 'vitest';
import { restoreOpenPositionsFromDb } from '../../app/positionRecovery.js';
import { PositionRegistry } from '../../core/state/positionRegistry.js';
import type { TradeRecord } from '../../core/types/trade.js';

function makeBuy(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id: 'buy-1',
    mint: 'TestMint111111111111111111111111111111111111',
    side: 'BUY',
    status: 'CONFIRMED',
    amountSol: 1_000_000n,
    amountTokens: 2_000_000_000n,
    signature: 'sig-1',
    slot: null,
    submittedAt: 1_000,
    confirmedAt: 2_000,
    failureReason: null,
    ...overrides,
  };
}

describe('restoreOpenPositionsFromDb', () => {
  it('rehydrates confirmed open BUY rows into registry and monitor set', async () => {
    const registry = new PositionRegistry();
    const monitored: string[] = [];

    const result = await restoreOpenPositionsFromDb({
      tradeRepository: { findOpenConfirmedBuys: async () => [makeBuy()] },
      positionRegistry: registry,
      monitorTrade: (tradeId) => monitored.push(tradeId),
    });

    expect(result).toEqual({ restored: 1, skipped: 0 });
    expect(monitored).toEqual(['buy-1']);

    const pos = registry.get('buy-1');
    expect(pos).toBeDefined();
    expect(pos?.status).toBe('ENTERED');
    expect(pos?.entryAmountSol).toBe(1_000_000n);
    expect(pos?.entryAmountTokens).toBe(2_000_000_000n);
    expect(pos?.entryTimestamp).toBe(2_000);
    expect(pos?.entryPriceSol).toBe(500n);
  });

  it('skips open BUY rows with zero token amount', async () => {
    const registry = new PositionRegistry();
    const monitored: string[] = [];

    const result = await restoreOpenPositionsFromDb({
      tradeRepository: { findOpenConfirmedBuys: async () => [makeBuy({ amountTokens: 0n })] },
      positionRegistry: registry,
      monitorTrade: (tradeId) => monitored.push(tradeId),
    });

    expect(result).toEqual({ restored: 0, skipped: 1 });
    expect(monitored).toEqual([]);
    expect(registry.getActiveCount()).toBe(0);
  });

  it('skips stale DB open BUY rows when the wallet no longer has token balance', async () => {
    const registry = new PositionRegistry();
    const monitored: string[] = [];

    const result = await restoreOpenPositionsFromDb({
      tradeRepository: { findOpenConfirmedBuys: async () => [makeBuy()] },
      positionRegistry: registry,
      monitorTrade: (tradeId) => monitored.push(tradeId),
      hasTokenBalance: async () => false,
    });

    expect(result).toEqual({ restored: 0, skipped: 1 });
    expect(monitored).toEqual([]);
    expect(registry.getActiveCount()).toBe(0);
  });
});
