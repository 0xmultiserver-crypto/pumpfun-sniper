/**
 * Migration Detector (Detector Layer)
 *
 * Detects when a Pump.fun token graduates (migrates to Raydium).
 * Emits MigrationSignal. Wraps the adapter-level migrationDetector
 * and adds signal emission.
 *
 * NOTE: This is the DETECTOR-layer migrationDetector (signal emission).
 * The ADAPTER-layer migrationDetector handles RPC + state parsing only.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { Signal, MigrationSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { PublicKey } from '@solana/web3.js';
import { detectFromLogs } from '../../adapters/protocols/pumpfun/migrationDetector.js';
import { DedupeSet } from '../../core/utils/dedupe.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('detectors:migration');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A transaction event that may contain migration data. */
export interface TransactionEvent {
  readonly mint: MintAddress;
  readonly logs: readonly string[];
  readonly slot: number;
  readonly signature: string;
}

/** Configuration. */
export interface MigrationDetectorConfig {
  /** TTL for signature deduplication (ms). Default: 120_000 (2 min). */
  readonly dedupeTtlMs?: number;
}

// ---------------------------------------------------------------------------
// MigrationSignalDetector
// ---------------------------------------------------------------------------

export class MigrationSignalDetector implements IDetector {
  readonly name = 'migration-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly dedupe: DedupeSet;
  private running = false;
  private signalCounter = 0;

  constructor(config?: MigrationDetectorConfig) {
    const ttl = config?.dedupeTtlMs ?? 120_000;
    this.dedupe = new DedupeSet(ttl);
    this.dedupe.startCleanup(30_000);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('Migration detector started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.dedupe.destroy();
    logger.info('Migration detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -----------------------------------------------------------------------

  /**
   * Check a transaction for migration events.
   *
   * Uses the adapter-layer detectFromLogs() to check if the transaction
   * logs contain a Pump.fun migration instruction.
   */
  handleTransaction(event: TransactionEvent): void {
    if (!this.running) return;

    const isMigration = detectFromLogs(event.logs);
    if (!isMigration) return;

    // Some Pump.fun migration log lines do not include program data that lets
    // our event decoder recover the mint. Never emit an empty/invalid mint into
    // the strategy path — PublicKey construction there would crash the bot.
    try {
      if (!event.mint) throw new Error('empty mint');
      new PublicKey(event.mint);
    } catch (_) {
      logger.debug('Migration event ignored — missing/invalid mint', {
        mint: event.mint,
        slot: event.slot,
        signature: event.signature,
      });
      return;
    }

    // Deduplicate by signature
    if (this.dedupe.isDuplicate(event.signature)) {
      return;
    }

    this.signalCounter += 1;
    const signalId = `migration-${event.slot}-${this.signalCounter}`;

    const signal: MigrationSignal = {
      id: signalId,
      type: 'MIGRATION',
      mint: event.mint,
      timestamp: nowMs(),
      slot: event.slot,
      migrationSignature: event.signature,
    };

    logger.info('Migration signal emitted', {
      signalId,
      mint: event.mint,
      slot: event.slot,
      signature: event.signature,
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
}
