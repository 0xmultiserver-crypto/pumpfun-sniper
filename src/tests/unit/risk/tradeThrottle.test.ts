import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TradeThrottle } from '../../../risk/controls/tradeThrottle.js';

describe('TradeThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first trade', () => {
    const throttle = new TradeThrottle();
    const result = throttle.canTrade();
    expect(result.allowed).toBe(true);
    expect(result.tradesInWindow).toBe(0);
  });

  it('records trade and tracks count', () => {
    const throttle = new TradeThrottle();
    throttle.recordTrade();

    const result = throttle.canTrade();
    // After 1 trade, should check min gap
    // With default 5s gap, should be blocked immediately
    expect(result.tradesInWindow).toBe(1);
  });

  it('blocks when max trades per window exceeded', () => {
    const throttle = new TradeThrottle({ maxTradesPerWindow: 2, minGapSeconds: 0 });
    throttle.recordTrade();
    throttle.recordTrade();

    const result = throttle.canTrade();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('trades in');
  });

  it('allows after window expires', () => {
    const throttle = new TradeThrottle({ maxTradesPerWindow: 1, windowSeconds: 60, minGapSeconds: 0 });
    throttle.recordTrade();

    expect(throttle.canTrade().allowed).toBe(false);

    vi.advanceTimersByTime(61_000); // past window

    expect(throttle.canTrade().allowed).toBe(true);
  });

  it('enforces minimum gap between trades', () => {
    const throttle = new TradeThrottle({ maxTradesPerWindow: 10, minGapSeconds: 5 });
    throttle.recordTrade();

    // Immediately after — should be blocked by gap
    const result = throttle.canTrade();
    expect(result.allowed).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);

    // After gap expires
    vi.advanceTimersByTime(5_001);
    expect(throttle.canTrade().allowed).toBe(true);
  });

  it('respects both gap and window limits', () => {
    const throttle = new TradeThrottle({
      maxTradesPerWindow: 2,
      windowSeconds: 60,
      minGapSeconds: 5,
    });

    throttle.recordTrade();
    vi.advanceTimersByTime(6_000); // past gap
    throttle.recordTrade();

    // Now at max trades for window, even past gap
    vi.advanceTimersByTime(6_000);
    expect(throttle.canTrade().allowed).toBe(false);
  });
});
