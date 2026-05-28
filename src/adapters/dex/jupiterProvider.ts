/**
 * Jupiter Routing Provider
 *
 * Implements IRoutingProvider for Jupiter V6 Aggregator.
 * Used for selling graduated tokens that have migrated to Raydium.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { IRoutingProvider, SwapRoute, QuoteParams } from './routingProvider.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('adapters:jupiter');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jupiter V6 quote API endpoint. */
const JUPITER_QUOTE_API = 'https://public.jupiterapi.com/quote';

/** SOL mint address (native, wrapped). */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// Jupiter API Types
// ---------------------------------------------------------------------------

interface JupiterQuoteResponse {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly priceImpactPct: string;
  readonly routePlan: readonly unknown[];
}

// ---------------------------------------------------------------------------
// JupiterProvider
// ---------------------------------------------------------------------------

export class JupiterProvider implements IRoutingProvider {
  readonly name = 'Jupiter V6';
  readonly venue = 'JUPITER' as const;

  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Jupiter can handle any token that has a Raydium/Orca pool.
   *
   * For now, we assume Jupiter can handle any graduated token.
   * In production, this should verify liquidity exists.
   */
  async canHandle(_mint: MintAddress): Promise<boolean> {
    // Jupiter can route most SPL tokens. In production, verify via
    // the Jupiter API that a route exists. For MVP, return true and
    // let quote() fail gracefully if no route is found.
    return true;
  }

  /**
   * Fetch a swap quote from the Jupiter V6 Quote API.
   */
  async quote(params: QuoteParams): Promise<SwapRoute | null> {
    const inputMint = params.direction === 'BUY' ? SOL_MINT : params.mint;
    const outputMint = params.direction === 'BUY' ? params.mint : SOL_MINT;

    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', params.amountLamports.toString());
    url.searchParams.set('slippageBps', params.slippageBps.toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn('Jupiter quote API returned non-OK status', {
          status: response.status,
          mint: params.mint,
          direction: params.direction,
        });
        return null;
      }

      const data = (await response.json()) as JupiterQuoteResponse;

      const outAmount = BigInt(data.outAmount);
      const otherAmountThreshold = BigInt(data.otherAmountThreshold);

      // Parse price impact from string percentage to bps
      const priceImpactPct = parseFloat(data.priceImpactPct);
      const priceImpactBps = Number.isFinite(priceImpactPct)
        ? Math.round(priceImpactPct * 100)
        : 0;

      logger.debug('Jupiter quote received', {
        mint: params.mint,
        direction: params.direction,
        inAmount: params.amountLamports.toString(),
        outAmount: outAmount.toString(),
        priceImpactBps,
      });

      return {
        venue: 'JUPITER',
        inputMint,
        outputMint,
        inputAmount: params.amountLamports,
        expectedOutputAmount: outAmount,
        minimumOutputAmount: otherAmountThreshold,
        slippageBps: params.slippageBps,
        priceImpactBps,
        routeData: data,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn('Jupiter quote API timed out', {
          mint: params.mint,
          timeoutMs: this.timeoutMs,
        });
      } else {
        logger.error('Jupiter quote API failed', {
          mint: params.mint,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
