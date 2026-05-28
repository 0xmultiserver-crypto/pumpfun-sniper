/**
 * Position Recovery
 *
 * Rehydrates active in-memory position/exit-monitor state from PostgreSQL on
 * startup. Without this, any bot restart after a confirmed BUY loses the
 * monitoredTrades Set, so TIMEOUT/TP/SL can never fire for that open position.
 */

import type { Connection, PublicKey } from '@solana/web3.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import type { TradeRecord } from '../core/types/trade.js';
import type { MintAddress } from '../core/types/token.js';
import { nowMs } from '../core/utils/time.js';
import { createLogger } from '../telemetry/logging/logger.js';
import { deriveUserATA } from '../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';

const logger = createLogger('app:positionRecovery');

export interface OpenBuyTradeRepository {
  findOpenConfirmedBuys(): Promise<readonly TradeRecord[]>;
}

export interface RestoreOpenPositionsParams {
  readonly tradeRepository: OpenBuyTradeRepository;
  readonly positionRegistry: PositionRegistry;
  readonly monitorTrade: (tradeId: string, mint?: string) => void;
  /** Optional live wallet-balance guard; false means DB row is stale and should not be monitored. */
  readonly hasTokenBalance?: (trade: TradeRecord) => Promise<boolean>;
}

export interface RestoreOpenPositionsResult {
  readonly restored: number;
  readonly skipped: number;
}

/** Restore in-memory positions from confirmed BUY rows that have no confirmed SELL. */
export async function restoreOpenPositionsFromDb(
  params: RestoreOpenPositionsParams,
): Promise<RestoreOpenPositionsResult> {
  const openBuys = await params.tradeRepository.findOpenConfirmedBuys();
  let restored = 0;
  let skipped = 0;

  for (const trade of openBuys) {
    if (trade.amountTokens <= 0n) {
      skipped += 1;
      logger.warn('Skipping DB open BUY with zero token amount', {
        tradeId: trade.id,
        mint: trade.mint,
      });
      continue;
    }

    if (params.hasTokenBalance && !(await params.hasTokenBalance(trade))) {
      skipped += 1;
      logger.warn('Skipping DB open BUY with no live wallet token balance', {
        tradeId: trade.id,
        mint: trade.mint,
      });
      continue;
    }

    const entryTimestamp = trade.confirmedAt ?? trade.submittedAt ?? nowMs();
    const entryPrice = (trade.amountSol * 10n ** 9n) / trade.amountTokens;

    params.positionRegistry.register({
      id: trade.id,
      mint: trade.mint as MintAddress,
      status: 'ENTERED',
      tradeId: trade.id,
      entryAmountSol: trade.amountSol,
      entryAmountTokens: trade.amountTokens,
      entryPriceSol: entryPrice,
      entryTimestamp,
      currentPnlPercent: null,
      exitReason: null,
      createdAt: entryTimestamp,
      updatedAt: nowMs(),
    });
    params.monitorTrade(trade.id, trade.mint);
    restored += 1;

    logger.info('Restored open BUY from DB for exit monitoring', {
      tradeId: trade.id,
      mint: trade.mint,
      ageMs: nowMs() - entryTimestamp,
      entryPrice: entryPrice.toString(),
    });
  }

  return { restored, skipped };
}

/**
 * Check if a wallet holds a live (on-chain) token balance for the given mint.
 * Used during DB recovery to skip stale positions whose tokens were already sold.
 * Works with both SPL Token and Token-2022.
 */
export async function hasLiveTokenBalance(
  connection: Connection,
  user: PublicKey,
  mint: PublicKey,
): Promise<boolean> {
  try {
    const mintAccount = await connection.getAccountInfo(mint);
    if (!mintAccount) return false;
    const tokenProgram = mintAccount.owner;
    const ata = deriveUserATA(user, mint, tokenProgram);
    // Use getTokenAccountBalance which works for both SPL and Token-2022
    const balance = await connection.getTokenAccountBalance(ata);
    return balance.value.uiAmount != null && balance.value.uiAmount > 0;
  } catch (err: unknown) {
    // Account might not exist (already closed) or RPC error
    logger.debug('Could not verify live token balance', {
      mint: mint.toBase58(),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
