/**
 * Rent Reclaimer
 *
 * Closes empty token ATAs after sell to reclaim rent (~0.002 SOL per account).
 * Solana requires rent-exempt balance for each account — closing returns it.
 *
 * Usage:
 *   - Called post-sell when token balance drops to 0
 *   - Can also batch-reclaim multiple stale accounts on startup
 */

import {
  PublicKey,
} from '@solana/web3.js';
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Connection } from '@solana/web3.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { buildComputeBudgetInstructions, DEFAULT_PUMPFUN_COMPUTE_BUDGET } from '../../execution/tx/computeBudgetBuilder.js';
import { recordRentReclaim } from '../../telemetry/metrics/prometheus.js';
import type { TxBuilder } from '../../execution/tx/txBuilder.js';
import type { SendCoordinator } from '../../execution/sender/sendCoordinator.js';

const logger = createLogger('app:execution:rentReclaimer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RentReclaimResult {
  readonly reclaimed: number;
  readonly totalLamports: bigint;
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Core Logic
// ---------------------------------------------------------------------------

/**
 * Close a single empty token ATA and reclaim rent.
 * Returns the reclaimed lamports (0 if balance was non-zero or tx failed).
 */
export async function reclaimSingleAccount(params: {
  readonly connection: Connection;
  readonly mint: PublicKey;
  readonly owner: PublicKey;
  readonly tokenProgram: PublicKey;
  readonly txBuilder: TxBuilder;
  readonly sendCoordinator: SendCoordinator;
}): Promise<{ reclaimed: boolean; signature: string | null; error: string | null }> {
  const ata = getAssociatedTokenAddressSync(
    params.mint,
    params.owner,
    false,
    params.tokenProgram,
  );

  // Check balance
  const balance = await params.connection.getTokenAccountBalance(ata).catch(() => null);
  if (!balance || BigInt(balance.value.amount) > 0n) {
    return { reclaimed: false, signature: null, error: null };
  }

  // Build close instruction
  const closeIx = createCloseAccountInstruction(
    ata,
    params.owner,
    params.owner,
    [],
    params.tokenProgram,
  );

  const instructions = [
    ...buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET),
    closeIx,
  ];

  try {
    const txResult = await params.txBuilder.build({
      feePayer: params.owner,
      instructions,
    });

    const sendResult = await params.sendCoordinator.signAndSend({
      tradeId: `rent-reclaim-${params.mint.toBase58().slice(0, 8)}`,
      transaction: txResult.transaction,
    });

    const signature = sendResult.sendResult?.signature ?? null;
    if (sendResult.error) {
      logger.warn('Rent reclaim TX failed', {
        mint: params.mint.toBase58(),
        error: sendResult.error,
      });
      return { reclaimed: false, signature, error: sendResult.error };
    }

    logger.info('Rent reclaimed', {
      mint: params.mint.toBase58(),
      ata: ata.toBase58(),
      signature,
    });
    // Each ATA rent is ~0.00203928 SOL (2,039,280 lamports)
    recordRentReclaim(2_039_280n);
    return { reclaimed: true, signature, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Rent reclaim error', { mint: params.mint.toBase58(), error: msg });
    return { reclaimed: false, signature: null, error: msg };
  }
}

/**
 * Scan wallet for empty token accounts and batch-reclaim rent.
 * Sends one TX per account (Solana TX size limits prevent true batching).
 */
export async function reclaimAllEmptyAccounts(params: {
  readonly connection: Connection;
  readonly owner: PublicKey;
  readonly txBuilder: TxBuilder;
  readonly sendCoordinator: SendCoordinator;
}): Promise<RentReclaimResult> {
  logger.info('Scanning for empty token accounts to reclaim rent...');

  // Fetch all token accounts owned by this wallet
  const tokenAccounts = await params.connection.getParsedTokenAccountsByOwner(
    params.owner,
    { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
  );
  const token2022Accounts = await params.connection.getParsedTokenAccountsByOwner(
    params.owner,
    { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') },
  );

  const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];
  const emptyAccounts: Array<{ mint: PublicKey; ata: PublicKey; tokenProgram: PublicKey }> = [];

  for (const account of allAccounts) {
    const parsed = account.account.data;
    if ('parsed' in parsed) {
      const info = parsed.parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? '0');
      if (amount === 0n) {
        const mint = new PublicKey(info.mint);
        const tokenProgram = account.account.owner.equals(
          new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
        )
          ? new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
          : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

        emptyAccounts.push({
          mint,
          ata: account.pubkey,
          tokenProgram,
        });
      }
    }
  }

  if (emptyAccounts.length === 0) {
    logger.info('No empty token accounts found — nothing to reclaim');
    return { reclaimed: 0, totalLamports: 0n, errors: [] };
  }

  logger.info(`Found ${emptyAccounts.length} empty token accounts — reclaiming rent...`);

  let reclaimed = 0;
  let totalLamports = 0n;
  const errors: string[] = [];

  for (const account of emptyAccounts) {
    const result = await reclaimSingleAccount({
      connection: params.connection,
      mint: account.mint,
      owner: params.owner,
      tokenProgram: account.tokenProgram,
      txBuilder: params.txBuilder,
      sendCoordinator: params.sendCoordinator,
    });

    if (result.reclaimed) {
      reclaimed++;
      // Each ATA rent is ~0.00203928 SOL (2,039,280 lamports)
      totalLamports += 2_039_280n;
    }
    if (result.error) {
      errors.push(`${account.mint.toBase58()}: ${result.error}`);
    }
  }

  logger.info('Rent reclaim complete', {
    reclaimed,
    total: emptyAccounts.length,
    totalLamports: totalLamports.toString(),
    errors: errors.length,
  });

  return { reclaimed, totalLamports, errors };
}
