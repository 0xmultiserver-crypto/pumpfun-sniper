import { describe, it, expect, vi } from 'vitest';
import { DailyLossGuard } from '../../../risk/controls/dailyLossGuard.js';

describe('DailyLossGuard', () => {
  it('allows trading initially', () => {
    const guard = new DailyLossGuard();
    expect(guard.canTrade()).toBe(true);
  });

  it('tracks cumulative P&L', () => {
    const guard = new DailyLossGuard();
    guard.recordTrade(-10, true); // -$10 SL
    guard.recordTrade(-5, false); // -$5 normal

    const state = guard.getState();
    expect(state.dailyPnlUsd).toBe(-15);
    expect(state.tradeCount).toBe(2);
    expect(state.stopLossCount).toBe(1);
    expect(state.limitBreached).toBe(false);
  });

  it('breaches at -$40 daily loss (LOCKED)', () => {
    const guard = new DailyLossGuard();
    guard.recordTrade(-15, true);
    guard.recordTrade(-15, true);
    expect(guard.canTrade()).toBe(true); // -$30 still ok

    guard.recordTrade(-10, true); // -$40 total
    expect(guard.canTrade()).toBe(false);

    const state = guard.getState();
    expect(state.limitBreached).toBe(true);
    expect(state.dailyPnlUsd).toBe(-40);
  });

  it('breaches beyond -$40', () => {
    const guard = new DailyLossGuard();
    guard.recordTrade(-50, true); // single big loss
    expect(guard.canTrade()).toBe(false);
  });

  it('fires kill callbacks on breach', () => {
    const guard = new DailyLossGuard();
    const callback = vi.fn();
    guard.onKill(callback);

    guard.recordTrade(-45, true);

    expect(callback).toHaveBeenCalledOnce();
    const state = callback.mock.calls[0]![0]!;
    expect(state.limitBreached).toBe(true);
    expect(state.dailyPnlUsd).toBe(-45);
  });

  it('does not fire callback twice on repeated losses', () => {
    const guard = new DailyLossGuard();
    const callback = vi.fn();
    guard.onKill(callback);

    guard.recordTrade(-45, true); // breach
    guard.recordTrade(-10, true); // more loss

    // Callback fires only once (first breach)
    expect(callback).toHaveBeenCalledOnce();
  });

  it('handles positive P&L (wins)', () => {
    const guard = new DailyLossGuard();
    guard.recordTrade(15, false); // +$15 win
    guard.recordTrade(-10, true); // -$10 loss

    const state = guard.getState();
    expect(state.dailyPnlUsd).toBe(5); // net +$5
    expect(state.limitBreached).toBe(false);
  });

  it('remaining budget decreases with losses', () => {
    const guard = new DailyLossGuard();
    expect(guard.getRemainingBudgetUsd()).toBe(40); // full budget

    guard.recordTrade(-10, true);
    expect(guard.getRemainingBudgetUsd()).toBe(30);

    guard.recordTrade(-20, true);
    expect(guard.getRemainingBudgetUsd()).toBe(10);
  });

  it('accepts custom kill limit', () => {
    const guard = new DailyLossGuard({ dailyKillLimitUsd: 100 });
    guard.recordTrade(-50, true);
    expect(guard.canTrade()).toBe(true); // -$50 ok with $100 limit

    guard.recordTrade(-60, true);
    expect(guard.canTrade()).toBe(false); // -$110 breached
  });

  it('survives callback that throws', () => {
    const guard = new DailyLossGuard();
    guard.onKill(() => {
      throw new Error('callback boom');
    });

    // Should not throw
    expect(() => guard.recordTrade(-50, true)).not.toThrow();
    expect(guard.canTrade()).toBe(false);
  });
});
