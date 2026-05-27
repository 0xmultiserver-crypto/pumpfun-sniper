/**
 * Routing Provider Interface
 *
 * Abstract routing provider for DEX swap execution.
 * Strategy code uses this interface — never touches protocol internals directly.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { ExecutionVenue, SwapDirection } from '../../core/types/execution.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A swap route returned by a routing provider. */
export interface SwapRoute {
  /** The venue this route will execute on. */
  readonly venue: ExecutionVenue;
  /** Input mint (SOL for buys, token for sells). */
  readonly inputMint: string;
  /** Output mint (token for buys, SOL for sells). */
  readonly outputMint: string;
  /** Input amount in smallest unit (lamports or token base units). */
  readonly inputAmount: bigint;
  /** Expected output amount (before slippage). */
  readonly expectedOutputAmount: bigint;
  /** Minimum output amount (after slippage). */
  readonly minimumOutputAmount: bigint;
  /** Slippage in basis points applied to this route. */
  readonly slippageBps: number;
  /** Estimated price impact in basis points. */
  readonly priceImpactBps: number;
  /** Opaque route data the provider needs for execution. */
  readonly routeData: unknown;
}

/** Parameters for requesting a swap quote. */
export interface QuoteParams {
  readonly mint: MintAddress;
  readonly direction: SwapDirection;
  readonly amountLamports: bigint;
  readonly slippageBps: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Abstract routing provider.
 *
 * Implementations (PumpfunRoutingProvider, JupiterRoutingProvider) provide
 * venue-specific quote and instruction-building logic.
 */
export interface IRoutingProvider {
  /** Human-readable name for logging. */
  readonly name: string;

  /** Which execution venue this provider serves. */
  readonly venue: ExecutionVenue;

  /**
   * Fetch a swap quote for the given parameters.
   * Returns null if the provider cannot serve this request.
   */
  quote(params: QuoteParams): Promise<SwapRoute | null>;

  /**
   * Whether this provider can handle the given mint at this moment.
   * Used for venue selection: e.g. Pump.fun only handles bonding-phase tokens.
   */
  canHandle(mint: MintAddress): Promise<boolean>;
}
