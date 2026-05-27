/**
 * Unit tests for MomentumDetector — bundle wallet detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MomentumDetector, type TradeEvent } from '@detectors/momentum/momentumDetector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuy(overrides?: Partial<TradeEvent>): TradeEvent {
  return {
    mint: 'TestMint111111111111111111111111111111111111',
    isBuy: true,
    solAmount: 200_000_000n, // 0.2 SOL
    slot: 422383700,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MomentumDetector — bundle detection', () => {
  let detector: MomentumDetector;
  let signals: Array<{ buyCount: number; uniqueSlotCount?: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new MomentumDetector({
      windowSeconds: 15,
      minBuyCount: 7,
      minVolumeLamports: 1_000_000_000n, // 1 SOL
      cooldownMs: 0, // no cooldown for testing
    });
    signals = [];
    detector.onSignal((signal) => {
      if (signal.type === 'MOMENTUM') {
        signals.push({
          buyCount: signal.buyCount,
          uniqueSlotCount: signal.uniqueSlotCount,
        });
      }
    });
    detector.start();
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  it('emits signal when buys spread across many slots (organic)', () => {
    // 7 buys across 7 different slots → organic
    for (let i = 0; i < 7; i++) {
      detector.handleTrade(makeBuy({
        slot: 422383700 + i,
        timestamp: Date.now(),
      }));
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].buyCount).toBe(7);
    expect(signals[0].uniqueSlotCount).toBe(7);
  });

  it('BLOCKS signal when all buys from 1 slot (bundle)', () => {
    // 7 buys from the same slot → bundle
    for (let i = 0; i < 7; i++) {
      detector.handleTrade(makeBuy({
        slot: 422383700, // all same slot
        timestamp: Date.now(),
      }));
    }
    expect(signals).toHaveLength(0); // blocked!
  });

  it('BLOCKS signal when 9 buys from 2 slots (bundle)', () => {
    // 9 buys from 2 slots → bundleRatio = 9/2 = 4.5 >= 3
    for (let i = 0; i < 5; i++) {
      detector.handleTrade(makeBuy({ slot: 422383700 }));
    }
    for (let i = 0; i < 4; i++) {
      detector.handleTrade(makeBuy({ slot: 422383701 }));
    }
    expect(signals).toHaveLength(0); // blocked!
  });

  it('emits signal when 7 buys from 3 slots (borderline organic)', () => {
    // 7 buys from 3 slots → bundleRatio = 7/3 = 2.33 < 3 → passes
    for (let i = 0; i < 3; i++) {
      detector.handleTrade(makeBuy({ slot: 422383700 }));
    }
    for (let i = 0; i < 2; i++) {
      detector.handleTrade(makeBuy({ slot: 422383701 }));
    }
    for (let i = 0; i < 2; i++) {
      detector.handleTrade(makeBuy({ slot: 422383702 }));
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].uniqueSlotCount).toBe(3);
  });

  it('emits signal when 7 buys from 4+ slots (definitely organic)', () => {
    for (let i = 0; i < 2; i++) {
      detector.handleTrade(makeBuy({ slot: 422383700 }));
    }
    for (let i = 0; i < 2; i++) {
      detector.handleTrade(makeBuy({ slot: 422383701 }));
    }
    for (let i = 0; i < 2; i++) {
      detector.handleTrade(makeBuy({ slot: 422383702 }));
    }
    detector.handleTrade(makeBuy({ slot: 422383703 }));
    expect(signals).toHaveLength(1);
    expect(signals[0].uniqueSlotCount).toBe(4);
  });

  it('sell events do not affect bundle detection', () => {
    // 7 buys from 1 slot + 5 sells from different slots
    for (let i = 0; i < 7; i++) {
      detector.handleTrade(makeBuy({ slot: 422383700 }));
    }
    for (let i = 0; i < 5; i++) {
      detector.handleTrade(makeBuy({
        isBuy: false,
        slot: 422383710 + i,
      }));
    }
    // Should still be blocked — sells don't count
    expect(signals).toHaveLength(0);
  });
});
