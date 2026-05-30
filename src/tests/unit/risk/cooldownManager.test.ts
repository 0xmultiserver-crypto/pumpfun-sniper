import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CooldownManager } from '../../../risk/controls/cooldownManager.js';

describe('CooldownManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows trading initially (no cooldown)', () => {
    const cm = new CooldownManager();
    const result = cm.canTrade();

    expect(result.allowed).toBe(true);
    expect(result.remainingMs).toBe(0);
    expect(result.reason).toBeNull();
  });

  it('uses locked default 10s cooldown', () => {
    const cm = new CooldownManager();
    expect(cm.getCooldownMs()).toBe(10_000);
  });

  it('blocks trading after activateCooldown()', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();

    const result = cm.canTrade();
    expect(result.allowed).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
    expect(result.reason).toContain('Cooldown active');
  });

  it('isActive() returns true during cooldown', () => {
    const cm = new CooldownManager();
    expect(cm.isActive()).toBe(false);

    cm.activateCooldown();
    expect(cm.isActive()).toBe(true);
  });

  it('allows trading after cooldown expires', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();

    expect(cm.canTrade().allowed).toBe(false);

    // Advance 10s + 1ms
    vi.advanceTimersByTime(10_001);

    expect(cm.canTrade().allowed).toBe(true);
    expect(cm.isActive()).toBe(false);
  });

  it('still blocked at 9s', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();

    vi.advanceTimersByTime(9_000); // 9s

    expect(cm.canTrade().allowed).toBe(false);
  });

  it('clearCooldown() immediately allows trading', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();
    expect(cm.canTrade().allowed).toBe(false);

    cm.clearCooldown();
    expect(cm.canTrade().allowed).toBe(true);
    expect(cm.isActive()).toBe(false);
  });

  it('accepts custom cooldown duration', () => {
    const cm = new CooldownManager({ cooldownAfterSlSeconds: 30 });
    expect(cm.getCooldownMs()).toBe(30_000);

    cm.activateCooldown();
    vi.advanceTimersByTime(29_000);
    expect(cm.canTrade().allowed).toBe(false);

    vi.advanceTimersByTime(2_000); // 31s total
    expect(cm.canTrade().allowed).toBe(true);
  });

  it('re-activation resets the timer', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();

    vi.advanceTimersByTime(5_000); // 5s

    cm.activateCooldown(); // re-activate — should reset to 10s from now

    vi.advanceTimersByTime(5_000); // another 5s (10s from start, 5s from re-activate)
    expect(cm.canTrade().allowed).toBe(false); // still in cooldown

    vi.advanceTimersByTime(5_001); // total 10s + 1ms from re-activate
    expect(cm.canTrade().allowed).toBe(true);
  });
});
