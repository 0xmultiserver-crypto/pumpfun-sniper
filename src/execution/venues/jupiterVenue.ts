/**
 * Jupiter Execution Venue
 *
 * Wraps Jupiter V6 swap execution. For graduated tokens that have
 * migrated to Raydium/Orca pools.
 *
 * Jupiter provides pre-built transaction instructions via their API,
 * so this venue fetches and deserializes them.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import { VersionedTransaction } from '@solana/web3.js';
import type { SwapRoute } from '../../adapters/dex/routingProvider.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:jupiterVenue');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jupiter V6 swap API endpoint. */
const JUPITER_SWAP_API = 'https://public.jupiterapi.com/swap';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Jupiter swap API response. */
interface JupiterSwapResponse {
  readonly swapTransaction: string; // Base64-encoded VersionedTransaction
}

/** Parameters for building a Jupiter swap transaction. */
export interface JupiterSwapParams {
  readonly route: SwapRoute;
  readonly userPublicKey: string;
  /** Whether to wrap/unwrap SOL automatically. Default: true. */
  readonly wrapUnwrapSOL?: boolean;
}

/** Result of building a Jupiter swap. */
export interface JupiterSwapResult {
  /** Pre-built transaction from Jupiter (needs signing). */
  readonly transaction: VersionedTransaction;
}

// ---------------------------------------------------------------------------
// JupiterVenue
// ---------------------------------------------------------------------------

export class JupiterVenue {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Build a swap transaction using Jupiter's swap API.
   *
   * Jupiter returns a pre-serialized VersionedTransaction that includes
   * all necessary instructions (compute budget, swap, cleanup).
   *
   * Returns null on failure.
   */
  async buildSwap(params: JupiterSwapParams): Promise<JupiterSwapResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: params.route.routeData,
          userPublicKey: params.userPublicKey,
          wrapAndUnwrapSol: params.wrapUnwrapSOL ?? true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn('Jupiter swap API returned non-OK status', {
          status: response.status,
        });
        return null;
      }

      const data = (await response.json()) as JupiterSwapResponse;

      // Deserialize the transaction
      const txBuffer = Buffer.from(data.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);

      logger.debug('Jupiter swap transaction built', {
        userPublicKey: params.userPublicKey,
      });

      return { transaction };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        logger.warn('Jupiter swap API timed out', {
          timeoutMs: this.timeoutMs,
        });
      } else {
        logger.error('Jupiter swap API failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
