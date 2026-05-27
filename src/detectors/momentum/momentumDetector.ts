/**
 * Momentum Detector
 *
 * Detects momentum signals from buy/sell activity on a token.
 * Uses a sliding time window to count buys and volume.
 * Emits MomentumSignal when thresholds are met.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { Signal, MomentumSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import {
  DEFAULT_MOMENTUM_WINDOW_SECONDS,
  DEFAULT_MOMENTUM_MIN_BUYS,
  DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS,
  DEFAULT_MOMENTUM_COOLDOWN_MS,
  DEFAULT_MOMENTUM_MAX_TRACKED_TOKENS,
} from '../../core/constants/defaults.js';

const logger = createLogger('detectors:momentum');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single trade event fed into the momentum detector. */
export interface TradeEvent {
  readonly mint: MintAddress;
  readonly isBuy: boolean;
  readonly solAmount: bigint;
  readonly slot: number;
  readonly timestamp: number;
}

/** Configuration for the momentum detector. */
export interface MomentumDetectorConfig {
  /** Time window in seconds to track buys. Default: 15. */
  readonly windowSeconds?: number;
  /** Minimum buy count within the window to emit signal. Default: 7. */
  readonly minBuyCount?: number;
  /** Minimum SOL volume (lamports) within the window. Default: 1_000_000_000 (1 SOL). */
  readonly minVolumeLamports?: bigint;
  /** Cooldown per mint in ms before re-emitting. Default: 60_000 (1 min). */
  readonly cooldownMs?: number;
  /** Max tokens to track simultaneously. Default: 500. */
  readonly maxTrackedTokens?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_SECONDS = DEFAULT_MOMENTUM_WINDOW_SECONDS;
const DEFAULT_MIN_BUY_COUNT = DEFAULT_MOMENTUM_MIN_BUYS;
const DEFAULT_MIN_VOLUME_LAMPORTS = DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS;
const DEFAULT_COOLDOWN_MS = DEFAULT_MOMENTUM_COOLDOWN_MS;
const DEFAULT_MAX_TRACKED_TOKENS = DEFAULT_MOMENTUM_MAX_TRACKED_TOKENS;

// ---------------------------------------------------------------------------
// Internal state per token
// ---------------------------------------------------------------------------

interface TokenMomentumState {
  /** Circular buffer of recent buy timestamps and amounts. */
  buys: Array<{ timestamp: number; solAmount: bigint; slot: number }>;
  /** Unique slots with buys in the current window. */
  uniqueSlots: Set<number>;
  /** Last time a momentum signal was emitted for this token. */
  lastSignalAt: number;
}

// ---------------------------------------------------------------------------
// MomentumDetector
// ---------------------------------------------------------------------------

export class MomentumDetector implements IDetector {
  readonly name = 'momentum-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly tokenStates = new Map<MintAddress, TokenMomentumState>();
  private running = false;
  private signalCounter = 0;

  private readonly windowMs: number;
  private readonly windowSeconds: number;
  private readonly minBuyCount: number;
  private readonly minVolumeLamports: bigint;
  private readonly cooldownMs: number;
  private readonly maxTrackedTokens: number;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: MomentumDetectorConfig) {
    this.windowSeconds = config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.windowMs = this.windowSeconds * 1000;
    this.minBuyCount = config?.minBuyCount ?? DEFAULT_MIN_BUY_COUNT;
    this.minVolumeLamports = config?.minVolumeLamports ?? DEFAULT_MIN_VOLUME_LAMPORTS;
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxTrackedTokens = config?.maxTrackedTokens ?? DEFAULT_MAX_TRACKED_TOKENS;
  }

  // -----------------------------------------------------------------------
  // IDetector implementation
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Periodic cleanup of stale token states
    this.cleanupTimer = setInterval(() => {
      this.purgeStaleTokens();
    }, 30_000);

    logger.info('Momentum detector started', {
      windowSeconds: this.windowSeconds,
      minBuyCount: this.minBuyCount,
      minVolumeLamports: this.minVolumeLamports.toString(),
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenStates.clear();
    logger.info('Momentum detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -----------------------------------------------------------------------

  /**
   * Process a trade event.
   *
   * Only buy events contribute to momentum. Sell events are ignored
   * for momentum detection (they reduce momentum, but we don't
   * subtract — the window naturally expires old buys).
   */
  handleTrade(event: TradeEvent): void {
    if (!this.running) return;
    if (!event.isBuy) return;

    // Enforce max tracked tokens
    if (!this.tokenStates.has(event.mint) && this.tokenStates.size >= this.maxTrackedTokens) {
      // Evict the oldest token
      this.evictOldest();
    }

    let state = this.tokenStates.get(event.mint);
    if (state === undefined) {
      state = { buys: [], uniqueSlots: new Set(), lastSignalAt: 0 };
      this.tokenStates.set(event.mint, state);
    }

    // Add buy
    state.buys.push({ timestamp: event.timestamp, solAmount: event.solAmount, slot: event.slot });
    state.uniqueSlots.add(event.slot);

    // Trim expired buys
    const cutoff = nowMs() - this.windowMs;
    const expiredSlots = new Set(state.buys.filter((b) => b.timestamp < cutoff).map(b => b.slot));
    state.buys = state.buys.filter((b) => b.timestamp >= cutoff);

    // Rebuild uniqueSlots from remaining buys
    for (const slot of expiredSlots) {
      if (!state.buys.some(b => b.slot === slot)) {
        state.uniqueSlots.delete(slot);
      }
    }

    // Check thresholds
    if (state.buys.length >= this.minBuyCount) {
      let totalVolume = 0n;
      for (const buy of state.buys) {
        totalVolume += buy.solAmount;
      }

      if (totalVolume >= this.minVolumeLamports) {
        // Bundle detection: many buys from very few slots = suspicious
        const uniqueSlotCount = state.uniqueSlots.size;
        const buyCount = state.buys.length;
        const bundleRatio = buyCount / Math.max(uniqueSlotCount, 1);

        if (bundleRatio >= 3 && uniqueSlotCount <= 2) {
          logger.warn('BUNDLE DETECTED — skipping momentum signal', {
            mint: event.mint.slice(0, 12),
            buyCount,
            uniqueSlots: uniqueSlotCount,
            bundleRatio: bundleRatio.toFixed(1),
          });
          return;
        }

        // Check cooldown
        const now = nowMs();
        if (now - state.lastSignalAt >= this.cooldownMs) {
          state.lastSignalAt = now;
          this.emitMomentumSignal(event.mint, buyCount, totalVolume, event.slot, uniqueSlotCount);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private emitMomentumSignal(
    mint: MintAddress,
    buyCount: number,
    volumeSol: bigint,
    slot: number,
    uniqueSlotCount: number,
  ): void {
    this.signalCounter += 1;
    const signalId = `momentum-${slot}-${this.signalCounter}`;

    const signal: MomentumSignal = {
      id: signalId,
      type: 'MOMENTUM',
      mint,
      timestamp: nowMs(),
      slot,
      buyCount,
      windowSeconds: this.windowSeconds,
      volumeSol,
      uniqueSlotCount,
    };

    logger.info('Momentum signal emitted', {
      signalId,
      mint,
      buyCount,
      volumeSol: volumeSol.toString(),
      windowSeconds: this.windowSeconds,
    });

    this.emit(signal);
  }

  private emit(signal: Signal): void {
    for (const handler of this.handlers) {
      try {
        handler(signal);
      } catch (err: unknown) {
        logger.error('Signal handler threw', {
          signalId: signal.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private purgeStaleTokens(): void {
    const cutoff = nowMs() - this.windowMs * 2;
    for (const [mint, state] of this.tokenStates) {
      // Remove tokens with no recent buys
      const latestBuy = state.buys[state.buys.length - 1];
      if (latestBuy === undefined || latestBuy.timestamp < cutoff) {
        this.tokenStates.delete(mint);
      }
    }
  }

  private evictOldest(): void {
    let oldestMint: MintAddress | null = null;
    let oldestTime = Infinity;

    for (const [mint, state] of this.tokenStates) {
      const latestBuy = state.buys[state.buys.length - 1];
      const ts = latestBuy?.timestamp ?? 0;
      if (ts < oldestTime) {
        oldestTime = ts;
        oldestMint = mint;
      }
    }

    if (oldestMint !== null) {
      this.tokenStates.delete(oldestMint);
    }
  }
}
