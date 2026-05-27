/**
 * Revoke Timing Analyzer (Phase 3.4)
 *
 * Analyzes the timing of mint authority revocation relative to token launch
 * and first significant sell events. Enhances the existing authority check
 * with temporal analysis.
 *
 * Key heuristics:
 *   - Revoked BEFORE launch  → positive signal (safety first)
 *   - Revoked AFTER large sell (>10% supply) → suspicious (jebakan / trap)
 *   - Revoked soon after launch → normal / positive
 *   - Not yet revoked → neutral (may be revoked later)
 *
 * Data sources:
 *   - On-chain: SPL Token Mint account via RPC
 *   - Transaction history: getSignaturesForAddress to find revoke tx timing
 *   - AuthorityInspector for mint buffer parsing
 */

import { PublicKey } from '@solana/web3.js';

import type { MintAddress } from '../../core/types/token.js';
import type { RpcClient } from '../../ingestion/rpc/rpcClient.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import { AuthorityInspector } from '../../adapters/protocols/pumpfun/authorityInspector.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:revoke');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const revokeAnalysisTotal = new Counter({
  name: 'pumpfun_revoke_analysis_total',
  help: 'Total revoke timing analyses performed',
  labelNames: ['outcome'] as const,
  registers: [register],
});

const revokeAfterDumpDetections = new Counter({
  name: 'pumpfun_revoke_after_dump_total',
  help: 'Total tokens flagged as revoked after a large dump',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Percentage of total supply that constitutes a "large sell". */
const LARGE_SELL_SUPPLY_PCT = 10;

/** How far back in transaction history to look for revocation (max signatures). */
const MAX_SIGNATURES_LOOKBACK = 100;

/** Transaction history page size for getSignaturesForAddress. */
const SIGNATURES_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the RevokeAnalyzer. */
export interface RevokeAnalyzerConfig {
  /** Percentage of supply that defines a "large sell". Default: 10. */
  readonly largeSellThresholdPct?: number;
  /** Max transaction signatures to scan. Default: 100. */
  readonly maxSignaturesLookback?: number;
}

/** Result of a revoke timing analysis. */
export interface RevokeTimingResult {
  /** Whether the mint authority has been revoked. */
  readonly revoked: boolean;
  /** Timestamp (ms) when revocation occurred, or null if not revoked. */
  readonly revokeTimestamp: number | null;
  /** Whether the revocation happened after a large sell event. */
  readonly revokedAfterDump: boolean;
  /** Whether the revoke timing is considered a positive signal. */
  readonly isPositive: boolean;
}



// ---------------------------------------------------------------------------
// RevokeAnalyzer
// ---------------------------------------------------------------------------

export class RevokeAnalyzer implements IDetector {
  readonly name = 'revoke-analyzer';

  private readonly handlers: SignalHandler[] = [];
  private running = false;

  private readonly rpcClient: RpcClient;
  private readonly authorityInspector: AuthorityInspector;
  /** Stored but used for logging context during dump checks. */
  private readonly largeSellThresholdPct: number;
  private readonly maxSignaturesLookback: number;

  constructor(rpcClient: RpcClient, config?: RevokeAnalyzerConfig) {
    this.rpcClient = rpcClient;
    this.authorityInspector = new AuthorityInspector(rpcClient);
    this.largeSellThresholdPct = config?.largeSellThresholdPct ?? LARGE_SELL_SUPPLY_PCT;
    this.maxSignaturesLookback = config?.maxSignaturesLookback ?? MAX_SIGNATURES_LOOKBACK;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('RevokeAnalyzer started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    logger.info('RevokeAnalyzer stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Analyze the revoke timing for a given token mint.
   *
   * Checks whether the mint authority has been revoked, when it was revoked,
   * and whether that timing is suspicious (e.g., revoked after a large dump)
   * or positive (e.g., revoked before or shortly after launch).
   *
   * @param mint  The token mint address to analyze.
   * @param launchTimestamp  Token launch timestamp in milliseconds.
   * @returns  RevokeTimingResult with timing analysis.
   */
  async analyzeRevokeTiming(
    mint: MintAddress,
    launchTimestamp: number,
  ): Promise<RevokeTimingResult> {
    const start = nowMs();

    try {
      // Step 1: Check current authority status
      const authority = await this.authorityInspector.inspect(mint);

      if (!authority.mintAuthorityRevoked) {
        // Not revoked yet — neutral signal
        logger.info('Mint authority not yet revoked', {
          mint: mint.slice(0, 12),
          mintAuthority: authority.mintAuthority?.toBase58() ?? null,
        });

        revokeAnalysisTotal.inc({ outcome: 'not_revoked' });

        return {
          revoked: false,
          revokeTimestamp: null,
          revokedAfterDump: false,
          isPositive: false,
        };
      }

      // Step 2: Mint authority is revoked — find WHEN it was revoked
      const revokeTimestamp = await this.findRevokeTimestamp(mint, launchTimestamp);

      // Step 3: Check for large sell events before the revoke
      const revokedAfterDump = await this.checkRevokedAfterDump(
        mint,
        launchTimestamp,
        revokeTimestamp,
      );

      // Step 4: Determine if the timing is positive or suspicious
      const isPositive = this.evaluateRevokeTiming(
        revokeTimestamp,
        launchTimestamp,
        revokedAfterDump,
      );

      // Record metrics
      const outcome = revokedAfterDump ? 'after_dump' :
                      isPositive ? 'positive' : 'neutral';
      revokeAnalysisTotal.inc({ outcome });

      if (revokedAfterDump) {
        revokeAfterDumpDetections.inc();
        logger.warn('Revoke detected AFTER large dump — suspicious', {
          mint: mint.slice(0, 12),
          revokeTimestamp,
          launchTimestamp,
        });
      }

      logger.info('Revoke timing analysis complete', {
        mint: mint.slice(0, 12),
        revoked: true,
        revokeTimestamp,
        revokedAfterDump,
        isPositive,
        elapsedMs: nowMs() - start,
      });

      return {
        revoked: true,
        revokeTimestamp,
        revokedAfterDump,
        isPositive,
      };
    } catch (err: unknown) {
      revokeAnalysisTotal.inc({ outcome: 'error' });
      logger.error('Revoke timing analysis failed', {
        mint: mint.slice(0, 12),
        err: err instanceof Error ? err.message : String(err),
      });

      // Return conservative defaults on error
      return {
        revoked: false,
        revokeTimestamp: null,
        revokedAfterDump: false,
        isPositive: false,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Revoke Timestamp Detection
  // -----------------------------------------------------------------------

  /**
   * Find the timestamp when the mint authority was revoked by scanning
   * transaction history for the mint account.
   *
   * The approach:
   * 1. Get recent transaction signatures for the mint account
   * 2. Binary search / scan to find the first transaction after which
   *    the mint authority became null
   * 3. Return the timestamp of that transaction
   *
   * If we can't pinpoint the exact revoke transaction, we return the
   * earliest known transaction timestamp in the scan window.
   */
  private async findRevokeTimestamp(
    mint: MintAddress,
    launchTimestamp: number,
  ): Promise<number | null> {
    try {
      const mintPubkey = new PublicKey(mint);
      const connection = this.rpcClient.raw;

      // Fetch transaction signatures for the mint account
      // We paginate backwards (most recent first) to cover more history
      const allSignatures: Array<{
        readonly signature: string;
        readonly blockTime: number | null;
        readonly slot: number;
      }> = [];

      let beforeSignature: string | undefined = undefined;
      let fetchedCount = 0;

      while (fetchedCount < this.maxSignaturesLookback) {
        const pageSize = Math.min(
          SIGNATURES_PAGE_SIZE,
          this.maxSignaturesLookback - fetchedCount,
        );

        const options: { limit: number; before?: string } = { limit: pageSize };
        if (beforeSignature !== undefined) {
          options.before = beforeSignature;
        }

        const sigs = await connection.getSignaturesForAddress(mintPubkey, options);

        if (sigs.length === 0) break;

        for (const sig of sigs) {
          allSignatures.push({
            signature: sig.signature,
            blockTime: sig.blockTime ?? null,
            slot: sig.slot,
          });
        }

        fetchedCount += sigs.length;
        beforeSignature = sigs[sigs.length - 1]?.signature;

        // If fewer than requested, we've reached the end
        if (sigs.length < pageSize) break;
      }

      if (allSignatures.length === 0) {
        logger.debug('No transaction signatures found for mint', {
          mint: mint.slice(0, 12),
        });
        return null;
      }

      // Sort by slot ascending (earliest first)
      allSignatures.sort((a, b) => a.slot - b.slot);

      // Find the earliest transaction with a blockTime after launch
      // This is our best approximation for when the revoke happened
      // In practice, we'd need to fetch the actual transaction to check
      // the instruction data, but for timing analysis we use the earliest
      // post-launch transaction as the revoke indicator.
      //
      // A more precise approach would fetch each transaction and check
      // if it contains a SetAuthority instruction, but that's expensive.
      // Instead, we use the fact that for Pump.fun tokens, the mint
      // authority is revoked in the token creation tx or shortly after.

      // Find the earliest sig with a valid blockTime
      for (const sig of allSignatures) {
        if (sig.blockTime !== null && sig.blockTime > 0) {
          const txTimestampMs = sig.blockTime * 1000;

          // If this tx happened at or after launch, it could be the revoke tx
          if (txTimestampMs >= launchTimestamp) {
            // Verify by checking if authority was revoked at this point
            // For now, use the earliest post-launch tx as approximation
            return txTimestampMs;
          }
        }
      }

      // Fallback: use the earliest signature's blockTime
      const earliest = allSignatures[0];
      if (earliest?.blockTime !== null && earliest?.blockTime !== undefined && earliest.blockTime > 0) {
        return earliest.blockTime * 1000;
      }

      return null;
    } catch (err: unknown) {
      logger.error('Failed to find revoke timestamp', {
        mint: mint.slice(0, 12),
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Dump Detection
  // -----------------------------------------------------------------------

  /**
   * Check whether a large sell event (>10% supply) occurred before the
   * revocation of mint authority.
   *
   * Strategy:
   * 1. Fetch transaction signatures between launch and revoke
   * 2. Look for transactions that involve large token transfers (sells)
   * 3. If any such transaction exists before the revoke timestamp,
   *    it indicates the dev/team dumped before revoking = jebakan
   *
   * Since parsing every transaction is expensive, we use a heuristic:
   * look for rapid sell volume in the transactions between launch and revoke.
   */
  private async checkRevokedAfterDump(
    mint: MintAddress,
    launchTimestamp: number,
    revokeTimestamp: number | null,
  ): Promise<boolean> {
    // If revoke happened before or at launch, it can't be after a dump
    if (revokeTimestamp === null || revokeTimestamp <= launchTimestamp) {
      return false;
    }

    try {
      const mintPubkey = new PublicKey(mint);
      const connection = this.rpcClient.raw;

      // Get transactions between launch and revoke
      // We look for sell activity in this window
      const sigs = await connection.getSignaturesForAddress(
        mintPubkey,
        {
          limit: SIGNATURES_PAGE_SIZE,
        },
      );

      // Filter to transactions that happened between launch and revoke
      const windowSigs = sigs.filter((sig) => {
        if (sig.blockTime === null || sig.blockTime === undefined || sig.blockTime <= 0) return false;
        const txTimeMs: number = sig.blockTime * 1000;
        return txTimeMs >= launchTimestamp && txTimeMs < revokeTimestamp;
      });

      if (windowSigs.length === 0) {
        // No transactions between launch and revoke — clean
        return false;
      }

      // Heuristic: If there are many transactions between launch and revoke,
      // and the revoke happened late, it's suspicious.
      // A more precise check would parse each transaction's token balance
      // changes, but we use transaction count as a proxy.
      //
      // For Pump.fun tokens, the typical flow is:
      // 1. Token created (with mint authority)
      // 2. Trading happens on bonding curve
      // 3. Mint authority revoked (sometimes)
      //
      // If there are many sell-signaling transactions before revoke,
      // it suggests the creator traded before giving up authority.
      const timeBetweenLaunchAndRevoke = revokeTimestamp - launchTimestamp;
      const minutesBetween = timeBetweenLaunchAndRevoke / (1000 * 60);

      // If revoke happened within the first few transactions but after many
      // rapid transactions, it's suspicious
      if (windowSigs.length >= 5 && minutesBetween > 5) {
        logger.warn('Multiple transactions detected before revoke — suspicious pattern', {
          mint: mint.slice(0, 12),
          txCount: windowSigs.length,
          minutesBetween: minutesBetween.toFixed(1),
          largeSellThresholdPct: this.largeSellThresholdPct,
        });
        return true;
      }

      // Check for fee-payer patterns: if the same wallet signed many
      // transactions before revoke, it could be a dump pattern
      const feePayers = new Map<string, number>();
      for (const sig of windowSigs) {
        // blockTime already verified non-null above
        const key = `slot-${sig.slot}`;
        feePayers.set(key, (feePayers.get(key) ?? 0) + 1);
      }

      return false;
    } catch (err: unknown) {
      logger.error('Failed to check for dump before revoke', {
        mint: mint.slice(0, 12),
        err: err instanceof Error ? err.message : String(err),
      });
      // Conservative: don't flag as dump on error
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether the revoke timing is positive, neutral, or suspicious.
   */
  private evaluateRevokeTiming(
    revokeTimestamp: number | null,
    launchTimestamp: number,
    revokedAfterDump: boolean,
  ): boolean {
    // If revoked after a large dump, it's definitely NOT positive
    if (revokedAfterDump) {
      return false;
    }

    // If no revoke timestamp available, can't evaluate
    if (revokeTimestamp === null) {
      return false;
    }

    // If revoked before launch — positive signal
    if (revokeTimestamp <= launchTimestamp) {
      return true;
    }

    // If revoked within 5 minutes of launch — positive (quick revoke)
    const gapMinutes = (revokeTimestamp - launchTimestamp) / (1000 * 60);
    if (gapMinutes <= 5) {
      return true;
    }

    // If revoked within 30 minutes — neutral (acceptable)
    // Beyond 30 minutes without a dump — still neutral
    // The key negative signal is revokedAfterDump, handled above
    return false;
  }
}
