/**
 * Emergency Kill Switch
 *
 * Global on/off switch for all trading activity.
 * When killed, NO new positions can be opened and existing
 * positions should be closed ASAP.
 *
 * This is the ultimate safety mechanism — overrides everything.
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:killSwitch');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Kill switch state. */
export interface KillSwitchState {
  /** Whether the bot is killed (all trading stopped). */
  readonly killed: boolean;
  /** Reason for the kill (null if not killed). */
  readonly reason: string | null;
  /** When the kill was activated (0 if not killed). */
  readonly killedAt: number;
  /** Who/what activated the kill. */
  readonly killedBy: string | null;
}

/** Kill switch event handler. */
export type KillSwitchHandler = (state: KillSwitchState) => void;

// ---------------------------------------------------------------------------
// EmergencyKillSwitch
// ---------------------------------------------------------------------------

export class EmergencyKillSwitch {
  private killed = false;
  private killedReason: string | null = null;
  private killedAt = 0;
  private killedBy: string | null = null;
  private readonly handlers: KillSwitchHandler[] = [];

  /**
   * Activate the kill switch.
   *
   * @param reason  Why the kill was triggered.
   * @param by      Who/what triggered it (e.g., 'daily-loss-guard', 'manual', 'error-rate').
   */
  kill(reason: string, by: string): void {
    if (this.killed) {
      logger.warn('Kill switch already active', { existingReason: this.killedReason });
      return;
    }

    this.killed = true;
    this.killedReason = reason;
    this.killedAt = nowMs();
    this.killedBy = by;

    logger.fatal('KILL SWITCH ACTIVATED', {
      reason,
      by,
      killedAt: this.killedAt,
    });

    const state = this.getState();
    for (const handler of this.handlers) {
      try {
        handler(state);
      } catch (err: unknown) {
        logger.error('Kill switch handler threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Deactivate the kill switch (manual recovery only).
   */
  reset(): void {
    if (!this.killed) return;

    logger.warn('Kill switch RESET — trading re-enabled', {
      previousReason: this.killedReason,
      wasKilledBy: this.killedBy,
    });

    this.killed = false;
    this.killedReason = null;
    this.killedAt = 0;
    this.killedBy = null;
  }

  /**
   * Check if trading is allowed.
   */
  isAlive(): boolean {
    return !this.killed;
  }

  /**
   * Get current kill switch state.
   */
  getState(): KillSwitchState {
    return {
      killed: this.killed,
      reason: this.killedReason,
      killedAt: this.killedAt,
      killedBy: this.killedBy,
    };
  }

  /**
   * Register a handler that fires when the kill switch is activated.
   */
  onKill(handler: KillSwitchHandler): void {
    this.handlers.push(handler);
  }
}
