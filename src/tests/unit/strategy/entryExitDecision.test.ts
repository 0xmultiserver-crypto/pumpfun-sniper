/**
 * Unit tests for strategies/filteredSniper/entryDecision.ts and exitDecision.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { evaluateEntry } from '@strategies/filteredSniper/entryDecision.js';
import { evaluateExit } from '@strategies/filteredSniper/exitDecision.js';
import { isExpectedBuyBlock } from '@strategies/filteredSniper/filteredSniperStrategy.js';
import type { EntryCheckData } from '@strategies/filteredSniper/entryDecision.js';
import type { PositionData } from '@strategies/filteredSniper/exitDecision.js';
import {
  ENTRY_CHECK_COUNT,
  TAKE_PROFIT_PERCENT,
  STOP_LOSS_PERCENT,
  TIMEOUT_SECONDS,
  TIMEOUT_MS,
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_MS,
  MAX_PRICE_IMPACT_BPS,
} from '@strategies/filteredSniper/filteredSniperRules.js';
import {
  DEFAULT_TAKE_PROFIT_PCT,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TIMEOUT_SECONDS,
} from '@core/constants/defaults.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntryData(overrides?: Partial<EntryCheckData>): EntryCheckData {
  return {
    mint: 'TestMint111111111111111111111111111111111111',
    launchDetected: true,
    creatorNotBlacklisted: true,
    creatorHistoryAcceptable: true,
    creatorScore: 50,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    metadataSane: true,
    liquiditySane: true,
    walletConcentrationAcceptable: true,
    buyCountInWindow: MOMENTUM_MIN_BUYS,
    volumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
    windowMs: MOMENTUM_WINDOW_MS,
    priceImpactBps: null,
    bundlePct: 10,
    washTradeScore: 20,
    uniqueWallets: 15,
    sellCountInWindow: 3,
    realSolReservesLamports: 1_000_000_000n,
    holderCount: 50,
    marketCapUsd: 50000,
    ...overrides,
  };
}

function priceAtPct(entryPriceLamports: bigint, pct: number): bigint {
  return entryPriceLamports + (entryPriceLamports * BigInt(pct)) / 100n;
}

function makePositionData(overrides?: Partial<PositionData>): PositionData {
  return {
    mint: 'TestMint111111111111111111111111111111111111',
    tradeId: 'trade-001',
    entryPriceLamports: 1_000_000_000n,
    currentPriceLamports: 1_000_000_000n,
    openedAt: Date.now() - 30_000, // 30s ago
    killSwitchActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Entry Decision
// ---------------------------------------------------------------------------

describe('evaluateEntry', () => {
  it('ENTRY_CHECK_COUNT is 18', () => {
    expect(ENTRY_CHECK_COUNT).toBe(18);
  });

  it('allows entry when all checks pass', () => {
    const data = makeEntryData();
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.passedCount).toBe(18);
  });

  it('rejects when mintAuthorityRevoked is false', () => {
    const data = makeEntryData({ mintAuthorityRevoked: false });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(false);
    expect(result.failedCount).toBeGreaterThan(0);
  });

  it('rejects when creatorNotBlacklisted is false', () => {
    const data = makeEntryData({ creatorNotBlacklisted: false });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(false);
  });

  it('rejects when momentum not met (low buy count)', () => {
    const data = makeEntryData({ buyCountInWindow: 1 });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(false);
  });

  it('rejects when launchDetected is false', () => {
    const data = makeEntryData({ launchDetected: false });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(false);
  });

  it('always returns exactly 18 checks', () => {
    const data = makeEntryData();
    const result = evaluateEntry(data);
    expect(result.checks.length).toBe(18)
  });

  it('firstFailure is null when all pass', () => {
    const data = makeEntryData();
    const result = evaluateEntry(data);
    expect(result.firstFailure).toBeNull();
  });

  it('firstFailure is set when a check fails', () => {
    const data = makeEntryData({ freezeAuthorityRevoked: false });
    const result = evaluateEntry(data);
    expect(result.firstFailure).not.toBeNull();
    expect(typeof result.firstFailure).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Exit Decision
// ---------------------------------------------------------------------------

describe('evaluateExit', () => {
  it('rule constants match rule.md', () => {
    expect(TAKE_PROFIT_PERCENT).toBe(DEFAULT_TAKE_PROFIT_PCT);
    expect(STOP_LOSS_PERCENT).toBe(-DEFAULT_STOP_LOSS_PCT);
    expect(TIMEOUT_SECONDS).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  it('returns TAKE_PROFIT at configured take-profit threshold', () => {
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: priceAtPct(1_000_000_000n, TAKE_PROFIT_PERCENT),
      scaleOutTiersCompleted: [0, 1], // All scale-out tiers done by index, so TAKE_PROFIT fires
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TAKE_PROFIT');
  });

  it('returns STOP_LOSS at configured stop-loss threshold', () => {
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: priceAtPct(1_000_000_000n, STOP_LOSS_PERCENT),
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('returns TIMEOUT when past configured timeout', () => {
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: 1_050_000_000n, // +5%, not TP/SL
      openedAt: Date.now() - (TIMEOUT_MS + 1000)
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TIMEOUT');
  });

  it('KILL_SWITCH beats everything', () => {
    const data = makePositionData({
      currentPriceLamports: 1_500_000_000n, // +40%
      killSwitchActive: true,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('KILL_SWITCH');
  });

  it('does not exit in normal range', () => {
    const data = makePositionData({
      currentPriceLamports: 1_100_000_000n, // +10%
      openedAt: Date.now() - 60_000, // 1 min
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('handles entry price 0 (division by zero guard)', () => {
    const data = makePositionData({
      entryPriceLamports: 0n,
      currentPriceLamports: 1_000_000_000n,
      openedAt: Date.now() - 30_000,
    });
    const result = evaluateExit(data);
    // Should not throw
    expect(result.shouldExit).toBe(false);
  });

  it('STOP_LOSS priority > TIMEOUT', () => {
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: priceAtPct(1_000_000_000n, STOP_LOSS_PERCENT),
      openedAt: Date.now() - (TIMEOUT_MS + 1000)
    });
    const result = evaluateExit(data);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('GRADUATED with real price uses normal exit logic (trailing/SL/TP)', () => {
    // Graduated tokens now use Jupiter price, not bonding curve.
    // Exit decision evaluates trailing/SL/TP normally.
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: 2_000_000_000n, // +100% PnL (from Jupiter price)
      graduated: true,
    });
    const result = evaluateExit(data);
    // At +100%, SCALE_OUT fires first (tier 0 = +100% sell 50%)
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('SCALE_OUT');
    expect(result.sellPct).toBe(50);
  });

  it('GRADUATED does NOT auto-sell — trailing/SL/TP handle it', () => {
    // With real Jupiter price, graduated token with +20% PnL is held
    // (below SCALE_OUT +100%, below trailing activation +70%)
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: 1_200_000_000n, // +20% PnL
      graduated: true,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('GRADUATED with price=0 triggers STOP_LOSS (Jupiter price unavailable)', () => {
    // Edge case: graduated but Jupiter price fetch failed and no prev highest
    // → price=0 → PnL = -100% → STOP_LOSS
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: 0n,
      graduated: true,
      highestPriceLamports: 0n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('non-graduated token with price=0 still triggers STOP_LOSS', () => {
    // Edge case: price dropped to zero but NOT graduated → real stop loss
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      currentPriceLamports: 0n,
      graduated: false,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('TRAILING_STOP triggers when price drops 50% from highest', () => {
    // Entry=100, highest=200 (+100% → activates trailing), current=95 (-52.5% from high)
    // Trailing 50% → stop at 200*0.50 = 100. 95 < 100 → trigger
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      highestPriceLamports: 2_000_000_000n,
      currentPriceLamports: 950_000_000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
    expect(result.pnlPercent).toBeCloseTo(-5, 0); // -5% from entry
  });

  it('TRAILING_STOP does NOT trigger when price within trailing range', () => {
    // Entry=100, highest=120 (+20%), current=111 (-7.5% from high)
    // PnL = +11% (below TP +70%), trailing 10% → stop at 108. 111 > 108 → no trigger
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      highestPriceLamports: 1_200_000_000n,
      currentPriceLamports: 1_110_000_000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(false);
  });

  it('TRAILING_STOP only activates when highest > entry', () => {
    // Entry=100, highest=95 (below entry), current=45
    // Trailing should NOT activate because highest never exceeded entry
    // PnL = -55% → STOP_LOSS triggers at -50%
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      highestPriceLamports: 950_000_000n,
      currentPriceLamports: 450_000_000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
  });

  it('TRAILING_STOP beats STOP_LOSS when both could trigger', () => {
    // Entry=100, highest=200 (+100% → activates), current=90 (-55% from high, -10% from entry)
    // Trailing 50% → stop at 100. 90 < 100 → TRAILING_STOP
    // SL at -50% → 50. 90 > 50 → SL does NOT trigger
    const data = makePositionData({
      entryPriceLamports: 1_000_000_000n,
      highestPriceLamports: 2_000_000_000n,
      currentPriceLamports: 900_000_000n,
    });
    const result = evaluateExit(data);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('pnlPercent is returned as number', () => {
    const data = makePositionData({
      currentPriceLamports: priceAtPct(1_000_000_000n, TAKE_PROFIT_PERCENT),
    });
    const result = evaluateExit(data);
    expect(typeof result.pnlPercent).toBe('number');
    expect(result.pnlPercent).toBeCloseTo(TAKE_PROFIT_PERCENT, 0);
  });
});

// ---------------------------------------------------------------------------
// Strategy buy block classification
// ---------------------------------------------------------------------------

describe('isExpectedBuyBlock', () => {
  it('classifies risk-guard buy blocks as expected non-errors', () => {
    expect(isExpectedBuyBlock('Cooldown active: 597s remaining')).toBe(true);
    expect(isExpectedBuyBlock('Kill switch: manual pause')).toBe(true);
    expect(isExpectedBuyBlock('Daily loss limit: $-40.00')).toBe(true);
    expect(isExpectedBuyBlock('Throttled: wait 5000ms')).toBe(true);
    expect(isExpectedBuyBlock('Max exposure reached')).toBe(true);
  });

  it('keeps real execution failures as errors', () => {
    expect(isExpectedBuyBlock(null)).toBe(false);
    expect(isExpectedBuyBlock('TX failed on-chain: Custom 6024')).toBe(false);
    expect(isExpectedBuyBlock('RPC sender failed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Price Impact Check (check 10)
// ---------------------------------------------------------------------------

describe('price impact check (check 10)', () => {
  it('passes when priceImpactBps is null (data unavailable)', () => {
    const data = makeEntryData({ priceImpactBps: null });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(true);
    const piCheck = result.checks.find(c => c.name === 'price_impact_acceptable');
    expect(piCheck).toBeDefined();
    expect(piCheck!.passed).toBe(true);
    expect(piCheck!.reason).toContain('unavailable');
  });

  it('passes when priceImpactBps is at the limit', () => {
    const data = makeEntryData({ priceImpactBps: MAX_PRICE_IMPACT_BPS });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(true);
    const piCheck = result.checks.find(c => c.name === 'price_impact_acceptable');
    expect(piCheck!.passed).toBe(true);
  });

  it('fails when priceImpactBps exceeds the limit', () => {
    const data = makeEntryData({ priceImpactBps: MAX_PRICE_IMPACT_BPS + 1 });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(false);
    const piCheck = result.checks.find(c => c.name === 'price_impact_acceptable');
    expect(piCheck!.passed).toBe(false);
    expect(piCheck!.reason).toContain('Price impact too high');
    expect(piCheck!.reason).toContain('max');
  });

  it('passes when priceImpactBps is zero', () => {
    const data = makeEntryData({ priceImpactBps: 0 });
    const result = evaluateEntry(data);
    expect(result.allowed).toBe(true);
  });

  it('price_impact_acceptable is the 10th check', () => {
    const data = makeEntryData();
    const result = evaluateEntry(data);
    expect(result.checks[9].name).toBe('price_impact_acceptable');
  });

  it('MAX_PRICE_IMPACT_BPS is 500 (5%)', () => {
    expect(MAX_PRICE_IMPACT_BPS).toBe(500);
  });
});
