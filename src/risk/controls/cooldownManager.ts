/**
 * Cooldown Manager
 *
 * Enforces cooldown periods after stop losses to prevent
 * revenge trading / tilt.
 *
 * LOCKED VALUES:
 *   - Cooldown after stop loss: 2 minutes (120 seconds)
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { DEFAULT_COOLDOWN_AFTER_SL_SECONDS } from '../../core/constants/defaults.js';
import type { RiskStateRepository } from '../../storage/repositories/riskStateRepository.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:cooldown');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cooldown check result. */
export interface CooldownCheckResult {
  /** Whether trading is allowed (no active cooldown). */
  readonly allowed: boolean;
  /** Remaining cooldown in ms (0 if allowed). */
  readonly remainingMs: number;
  /** When the cooldown expires (0 if no active cooldown). */
  readonly expiresAt: number;
  /** Reason if not allowed. */
  readonly reason: string | null;
}

/** Configuration. */
export interface CooldownManagerConfig {
  /** Cooldown duration after stop loss in seconds. Default: 120 (LOCKED). */
  readonly cooldownAfterSlSeconds?: number;
  /** Optional risk state repository for persistence. */
  readonly riskStateRepo?: RiskStateRepository;
}

// ---------------------------------------------------------------------------
// CooldownManager
// ---------------------------------------------------------------------------

export class CooldownManager {
  private readonly cooldownMs: number;
  private cooldownExpiresAt = 0;
  private readonly riskStateRepo: RiskStateRepository | null;

  private static readonly STATE_KEY = 'cooldown_manager';

  constructor(config?: CooldownManagerConfig) {
    const seconds = config?.cooldownAfterSlSeconds ?? DEFAULT_COOLDOWN_AFTER_SL_SECONDS;
    this.cooldownMs = seconds * 1000;
    this.riskStateRepo = config?.riskStateRepo ?? null;
  }

  /**
   * Activate cooldown (call after a stop loss exit).
   */
  activateCooldown(): void {
    this.cooldownExpiresAt = nowMs() + this.cooldownMs;
    logger.info('Cooldown activated', {
      durationMs: this.cooldownMs,
      expiresAt: this.cooldownExpiresAt,
    });

    // Persist to DB (fire-and-forget)
    void this.saveToDb();
  }

  /**
   * Check if trading is currently allowed.
   */
  canTrade(): CooldownCheckResult {
    const now = nowMs();

    if (this.cooldownExpiresAt > now) {
      const remainingMs = this.cooldownExpiresAt - now;
      const remainingSec = Math.ceil(remainingMs / 1000);

      logger.debug('Cooldown active', { remainingSec });
      return {
        allowed: false,
        remainingMs,
        expiresAt: this.cooldownExpiresAt,
        reason: `Cooldown active: ${remainingSec}s remaining`,
      };
    }

    return {
      allowed: true,
      remainingMs: 0,
      expiresAt: 0,
      reason: null,
    };
  }

  /**
   * Force-clear the cooldown (for emergency override / testing).
   */
  clearCooldown(): void {
    this.cooldownExpiresAt = 0;
    logger.warn('Cooldown manually cleared');

    // Persist cleared state to DB (fire-and-forget)
    void this.saveToDb();
  }

  /**
   * Check if cooldown is currently active.
   */
  isActive(): boolean {
    return this.cooldownExpiresAt > nowMs();
  }

  /**
   * Get configured cooldown duration in ms.
   */
  getCooldownMs(): number {
    return this.cooldownMs;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Restore cooldown state from DB. Call once at startup after DB is connected.
   * If the saved expiry is in the past, ignores it (cooldown expired).
   */
  async restore(): Promise<void> {
    if (this.riskStateRepo === null) return;

    try {
      const saved = await this.riskStateRepo.loadState<{ cooldownExpiresAt: number }>(
        CooldownManager.STATE_KEY,
      );

      if (saved === null) {
        logger.info('No saved cooldown state found — starting fresh');
        return;
      }

      if (saved.cooldownExpiresAt <= nowMs()) {
        logger.info('Saved cooldown has expired — ignoring', {
          savedExpiry: saved.cooldownExpiresAt,
          now: nowMs(),
        });
        return;
      }

      this.cooldownExpiresAt = saved.cooldownExpiresAt;
      logger.info('Cooldown state restored from DB', {
        expiresAt: this.cooldownExpiresAt,
        remainingMs: this.cooldownExpiresAt - nowMs(),
      });
    } catch (err: unknown) {
      logger.warn('Failed to restore cooldown state — starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private saveToDb(): void {
    if (this.riskStateRepo === null) return;

    void this.riskStateRepo.saveState(CooldownManager.STATE_KEY, {
      cooldownExpiresAt: this.cooldownExpiresAt,
    });
  }
}
