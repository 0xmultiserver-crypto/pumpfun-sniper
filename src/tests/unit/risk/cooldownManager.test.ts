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

  it('uses locked default 120s (2min) cooldown', () => {
    const cm = new CooldownManager();
    expect(cm.getCooldownMs()).toBe(120_000);
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

    // Advance 2 minutes + 1ms
    vi.advanceTimersByTime(120_001);

    expect(cm.canTrade().allowed).toBe(true);
    expect(cm.isActive()).toBe(false);
  });

  it('still blocked at 1min 59s', () => {
    const cm = new CooldownManager();
    cm.activateCooldown();

    vi.advanceTimersByTime(119_000); // 1min 59s

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

    vi.advanceTimersByTime(60_000); // 1 min

    cm.activateCooldown(); // re-activate — should reset to 2 min from now

    vi.advanceTimersByTime(60_000); // another 1 min (2 min from start, 1 from re-activate)
    expect(cm.canTrade().allowed).toBe(false); // still in cooldown

    vi.advanceTimersByTime(60_001); // total 2min + 1ms from re-activate
    expect(cm.canTrade().allowed).toBe(true);
  });
});
