import type { ServiceContainer } from '../container.js';

export interface RiskGuardResult {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * Run all 5 risk guard checks in order.
 * Returns the first failure or { allowed: true, reason: null }.
 *
 * Guards checked (in order):
 *   1. Emergency kill switch
 *   2. Daily loss limit
 *   3. Cooldown after stop loss
 *   4. Trade throttle
 *   5. Max exposure (async)
 */
export async function runRiskGuards(container: ServiceContainer): Promise<RiskGuardResult> {
  // Guard 1: Kill switch
  if (!container.killSwitch.isAlive()) {
    const state = container.killSwitch.getState();
    return { allowed: false, reason: `Kill switch: ${state.reason}` };
  }

  // Guard 2: Daily loss limit
  if (!container.dailyLossGuard.canTrade()) {
    const state = container.dailyLossGuard.getState();
    return { allowed: false, reason: `Daily loss limit: $${state.dailyPnlUsd.toFixed(2)}` };
  }

  // Guard 3: Cooldown after exit (all exits except SCALE_OUT)
  const cooldownCheck = container.cooldownManager.canTrade();
  if (!cooldownCheck.allowed) {
    return { allowed: false, reason: cooldownCheck.reason ?? 'Cooldown active' };
  }

  // Guard 4: Trade throttle
  const throttleCheck = container.tradeThrottle.canTrade();
  if (!throttleCheck.allowed) {
    return { allowed: false, reason: throttleCheck.reason ?? 'Throttled' };
  }

  // Guard 5: Max exposure (async)
  const exposureCheck = await container.maxExposureGuard.canOpenPosition();
  if (!exposureCheck.allowed) {
    return { allowed: false, reason: exposureCheck.reason ?? 'Max exposure' };
  }

  return { allowed: true, reason: null };
}
