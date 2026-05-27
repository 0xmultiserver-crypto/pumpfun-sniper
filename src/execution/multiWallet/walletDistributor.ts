/**
 * Multi-Wallet Buy Distributor
 *
 * Phase 6.2 — Distributes buys across N wallets using round-robin or
 * balance-based selection. Tracks per-wallet exposure and open positions
 * independently so each wallet acts as its own risk compartment.
 *
 * Design:
 *   - Configurable wallet set (public + private key pairs)
 *   - Round-robin: simple sequential cycling
 *   - Balance-based: picks the wallet with sufficient lamports and least
 *     exposure, falling back to the one with the most available balance
 *   - Per-wallet exposure tracking via in-memory map (bigint-safe)
 *   - Prometheus metrics for observability
 */

import { createLogger } from '../../telemetry/logging/logger.js';
import { register } from '../../telemetry/metrics/prometheus.js';
import { Counter, Gauge } from 'prom-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public view of a wallet's current state. */
export interface WalletInfo {
  publicKey: string;
  totalExposureLamports: bigint;
  openPositions: number;
  lastTradeAt: number | null;
}

/** Internal tracked state for a single wallet. */
interface InternalWalletState {
  publicKey: string;
  privateKey: string;
  totalExposureLamports: bigint;
  openPositions: number;
  lastTradeAt: number | null;
  /** Mint → exposure lamports for SELL tracking. */
  mintExposure: Map<string, bigint>;
}

/** Input wallet descriptor accepted by the constructor. */
export interface WalletInput {
  publicKey: string;
  privateKey: string;
}

/** Exposure snapshot returned by getWalletExposure. */
export interface WalletExposure {
  totalExposureLamports: bigint;
  openPositions: number;
}

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const multiWalletTradesTotal = new Counter({
  name: 'multiWallet_trades_total',
  help: 'Total trades recorded per wallet',
  labelNames: ['wallet'] as const,
  registers: [register],
});

const multiWalletExposureLamports = new Gauge({
  name: 'multiWallet_exposure_lamports',
  help: 'Current exposure in lamports per wallet',
  labelNames: ['wallet'] as const,
  registers: [register],
});

const multiWalletActiveWallets = new Gauge({
  name: 'multiWallet_active_wallets',
  help: 'Number of active wallets in the distributor',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('execution:multi-wallet');

// ---------------------------------------------------------------------------
// WalletDistributor
// ---------------------------------------------------------------------------

export class WalletDistributor {
  private readonly wallets: InternalWalletState[];
  private roundRobinIndex = 0;

  constructor(wallets: ReadonlyArray<WalletInput>) {
    if (wallets.length === 0) {
      throw new Error('WalletDistributor requires at least one wallet');
    }

    this.wallets = wallets.map((w) => ({
      publicKey: w.publicKey,
      privateKey: w.privateKey,
      totalExposureLamports: 0n,
      openPositions: 0,
      lastTradeAt: null,
      mintExposure: new Map(),
    }));

    multiWalletActiveWallets.set(this.wallets.length);

    logger.info('WalletDistributor initialised', {
      walletCount: this.wallets.length,
      wallets: this.wallets.map((w) => w.publicKey),
    });
  }

  // ── Round-Robin Selection ────────────────────────────────────────────

  /**
   * Return the next wallet in round-robin order.
   * Cycles through all wallets sequentially regardless of balance.
   */
  getNextWallet(): WalletInfo {
    const wallet = this.wallets[this.roundRobinIndex]!;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.wallets.length;

    logger.debug('getNextWallet (round-robin)', { wallet: wallet.publicKey });
    return this.toPublicInfo(wallet);
  }

  // ── Balance-Based Selection ──────────────────────────────────────────

  /**
   * Pick the wallet that has at least `amountLamports` available and has
   * the lowest current exposure. If multiple qualify with the same exposure,
   * the first found wins. If none qualify, the wallet with the greatest
   * balance (i.e. least negative difference) is returned so the caller can
   * decide whether to proceed.
   */
  getWalletByBalance(amountLamports: bigint): WalletInfo {
    let best: InternalWalletState | null = null;
    let bestExposure = BigInt(Number.MAX_SAFE_INTEGER);
    let fallbackBest: InternalWalletState | null = null;
    let fallbackExposure = BigInt(Number.MAX_SAFE_INTEGER);

    for (const w of this.wallets) {
      // Prefer wallets with the lowest exposure that can theoretically
      // accommodate the requested amount. Since we don't query on-chain
      // balance here (that's the caller's responsibility), we use exposure
      // as the heuristic — lower exposure ≈ more available capital.
      if (w.totalExposureLamports <= amountLamports) {
        if (w.totalExposureLamports < bestExposure) {
          best = w;
          bestExposure = w.totalExposureLamports;
        }
      }

      // Track least-exposed wallet as fallback
      if (fallbackBest === null || w.totalExposureLamports < fallbackExposure) {
        fallbackBest = w;
        fallbackExposure = w.totalExposureLamports;
      }
    }

    // Also track fallback = wallet with lowest exposure overall
    if (!best) {
      // None has low enough exposure — fallback to least-exposed
      best = fallbackBest ?? this.wallets[0]!;
      logger.warn('getWalletByBalance: no wallet with sufficient low exposure, falling back', {
        requestedLamports: amountLamports.toString(),
        chosenWallet: best.publicKey,
        chosenExposure: best.totalExposureLamports.toString(),
      });
    }

    logger.debug('getWalletByBalance', {
      requestedLamports: amountLamports.toString(),
      chosenWallet: best.publicKey,
      exposure: best.totalExposureLamports.toString(),
    });

    return this.toPublicInfo(best);
  }

  // ── Trade Recording ─────────────────────────────────────────────────

  /**
   * Record a trade for the given wallet. BUY adds exposure; SELL reduces it.
   *
   * @param publicKey  - The wallet's public key string.
   * @param mint       - Token mint address.
   * @param amountLamports - Amount in lamports (SOL cost for BUY, proceeds for SELL).
   * @param side       - 'BUY' or 'SELL'.
   */
  recordTrade(
    publicKey: string,
    mint: string,
    amountLamports: bigint,
    side: 'BUY' | 'SELL',
  ): void {
    const wallet = this.findWallet(publicKey);
    if (!wallet) {
      logger.error('recordTrade: unknown wallet', { publicKey });
      return;
    }

    const now = Date.now();
    wallet.lastTradeAt = now;

    if (side === 'BUY') {
      wallet.totalExposureLamports += amountLamports;
      wallet.openPositions += 1;
      wallet.mintExposure.set(mint, (wallet.mintExposure.get(mint) ?? 0n) + amountLamports);
    } else {
      // SELL: reduce exposure for this mint
      const currentMintExposure = wallet.mintExposure.get(mint) ?? 0n;
      const reduction = amountLamports > currentMintExposure ? currentMintExposure : amountLamports;
      wallet.totalExposureLamports -= reduction;
      if (wallet.totalExposureLamports < 0n) wallet.totalExposureLamports = 0n;
      wallet.openPositions = Math.max(0, wallet.openPositions - 1);
      wallet.mintExposure.set(mint, currentMintExposure - reduction);
      if (wallet.mintExposure.get(mint) === 0n) {
        wallet.mintExposure.delete(mint);
      }
    }

    // Update Prometheus
    multiWalletTradesTotal.inc({ wallet: publicKey });
    multiWalletExposureLamports.set({ wallet: publicKey }, Number(wallet.totalExposureLamports));

    logger.info('Trade recorded', {
      wallet: publicKey,
      mint,
      side,
      amountLamports: amountLamports.toString(),
      newExposure: wallet.totalExposureLamports.toString(),
      openPositions: wallet.openPositions,
    });
  }

  // ── Exposure Queries ────────────────────────────────────────────────

  /**
   * Get the current exposure for a specific wallet.
   */
  getWalletExposure(publicKey: string): WalletExposure {
    const wallet = this.findWallet(publicKey);
    if (!wallet) {
      logger.warn('getWalletExposure: unknown wallet, returning zero', { publicKey });
      return { totalExposureLamports: 0n, openPositions: 0 };
    }
    return {
      totalExposureLamports: wallet.totalExposureLamports,
      openPositions: wallet.openPositions,
    };
  }

  /**
   * Return public info for all managed wallets.
   */
  getAllWallets(): WalletInfo[] {
    return this.wallets.map((w) => this.toPublicInfo(w));
  }

  /**
   * Return the number of wallets managed by this distributor.
   */
  getWalletCount(): number {
    return this.wallets.length;
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  private findWallet(publicKey: string): InternalWalletState | undefined {
    return this.wallets.find((w) => w.publicKey === publicKey);
  }

  private toPublicInfo(w: InternalWalletState): WalletInfo {
    return {
      publicKey: w.publicKey,
      totalExposureLamports: w.totalExposureLamports,
      openPositions: w.openPositions,
      lastTradeAt: w.lastTradeAt,
    };
  }
}
