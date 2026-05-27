/**
 * Launch Detector
 *
 * Detects new Pump.fun token launches from ingestion pipeline events.
 * Emits LaunchSignal when a new token creation is confirmed.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { Signal, LaunchSignal } from '../../core/types/signal.js';
import type { LaunchEvent } from '../../core/types/signal.js';
type PumpfunLaunchEvent = LaunchEvent;
import { DedupeSet } from '../../core/utils/dedupe.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('detectors:launch');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LaunchDetectorConfig {
  /** TTL for signature deduplication (ms). Default: 60_000 (1 min). */
  readonly dedupeTtlMs?: number;
  /** Cleanup interval for the dedupe set (ms). Default: 30_000. */
  readonly dedupeCleanupMs?: number;
}

const DEFAULT_DEDUPE_TTL_MS = 60_000;
const DEFAULT_DEDUPE_CLEANUP_MS = 30_000;

// ---------------------------------------------------------------------------
// LaunchDetector
// ---------------------------------------------------------------------------

/**
 * Stateful detector that converts PumpfunLaunchEvent → LaunchSignal.
 *
 * Usage:
 *   const detector = new LaunchDetector();
 *   detector.onSignal((signal) => { ... });
 *   await detector.start();
 *   // Feed events from the ingestion pipeline:
 *   detector.handleLaunchEvent(event);
 */
export class LaunchDetector implements IDetector {
  readonly name = 'launch-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly dedupe: DedupeSet;
  private running = false;
  private signalCounter = 0;

  constructor(config?: LaunchDetectorConfig) {
    const ttl = config?.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.dedupe = new DedupeSet(ttl);

    const cleanupMs = config?.dedupeCleanupMs ?? DEFAULT_DEDUPE_CLEANUP_MS;
    this.dedupe.startCleanup(cleanupMs);
  }

  // -----------------------------------------------------------------------
  // IDetector implementation
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('Launch detector started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.dedupe.destroy();
    logger.info('Launch detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -----------------------------------------------------------------------

  /**
   * Process a parsed Pump.fun launch event.
   *
   * Deduplicates by transaction signature, then emits a LaunchSignal
   * to all registered handlers.
   */
  handleLaunchEvent(event: PumpfunLaunchEvent): void {
    if (!this.running) return;

    // Deduplicate by tx signature
    if (this.dedupe.isDuplicate(event.signature)) {
      logger.debug('Duplicate launch event ignored', {
        mint: event.mint,
        signature: event.signature,
      });
      return;
    }

    this.signalCounter += 1;
    const signalId = `launch-${event.slot}-${this.signalCounter}`;

    const signal: LaunchSignal = {
      id: signalId,
      type: 'LAUNCH',
      mint: event.mint,
      timestamp: nowMs(),
      slot: event.slot,
      creator: event.creator,
      signature: event.signature,
    };

    logger.info('Launch signal emitted', {
      signalId,
      mint: event.mint,
      creator: event.creator,
      slot: event.slot,
    });

    this.emit(signal);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

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
}
