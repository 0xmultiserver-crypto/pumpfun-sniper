import { describe, it, expect, vi } from 'vitest';
import {
  EmergencyKillSwitch,
  type KillSwitchHandler,
} from '../../../risk/controls/emergencyKillSwitch.js';

describe('EmergencyKillSwitch', () => {
  it('starts alive (not killed)', () => {
    const ks = new EmergencyKillSwitch();
    expect(ks.isAlive()).toBe(true);

    const state = ks.getState();
    expect(state.killed).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.killedAt).toBe(0);
    expect(state.killedBy).toBeNull();
  });

  it('kill() stops all trading', () => {
    const ks = new EmergencyKillSwitch();
    ks.kill('daily loss exceeded', 'daily-loss-guard');

    expect(ks.isAlive()).toBe(false);

    const state = ks.getState();
    expect(state.killed).toBe(true);
    expect(state.reason).toBe('daily loss exceeded');
    expect(state.killedBy).toBe('daily-loss-guard');
    expect(state.killedAt).toBeGreaterThan(0);
  });

  it('fires onKill handlers', () => {
    const ks = new EmergencyKillSwitch();
    const handler = vi.fn();
    ks.onKill(handler);

    ks.kill('test reason', 'test');

    expect(handler).toHaveBeenCalledOnce();
    const state = handler.mock.calls[0]![0]!;
    expect(state.killed).toBe(true);
    expect(state.reason).toBe('test reason');
  });

  it('does not double-kill (idempotent)', () => {
    const ks = new EmergencyKillSwitch();
    const handler = vi.fn();
    ks.onKill(handler);

    ks.kill('first', 'a');
    ks.kill('second', 'b'); // should be ignored

    expect(handler).toHaveBeenCalledOnce();
    expect(ks.getState().reason).toBe('first');
    expect(ks.getState().killedBy).toBe('a');
  });

  it('reset() re-enables trading', () => {
    const ks = new EmergencyKillSwitch();
    ks.kill('oops', 'manual');
    expect(ks.isAlive()).toBe(false);

    ks.reset();
    expect(ks.isAlive()).toBe(true);

    const state = ks.getState();
    expect(state.killed).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.killedAt).toBe(0);
    expect(state.killedBy).toBeNull();
  });

  it('reset() on non-killed is no-op', () => {
    const ks = new EmergencyKillSwitch();
    ks.reset(); // should not throw
    expect(ks.isAlive()).toBe(true);
  });

  it('survives handler that throws', () => {
    const ks = new EmergencyKillSwitch();
    ks.onKill(() => { throw new Error('handler boom'); });

    expect(() => ks.kill('test', 'test')).not.toThrow();
    expect(ks.isAlive()).toBe(false);
  });

  it('fires multiple handlers', () => {
    const ks = new EmergencyKillSwitch();
    const h1 = vi.fn();
    const h2 = vi.fn();
    ks.onKill(h1);
    ks.onKill(h2);

    ks.kill('multi', 'test');

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});
