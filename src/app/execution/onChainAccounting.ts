import type { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('app:execution:onChainAccounting');

export interface WalletSolAccounting {
  readonly walletDeltaLamports: bigint;
  readonly feeLamports: bigint;
  readonly rentPaidLamports: bigint;
  readonly rentRefundedLamports: bigint;
}

export interface TradeSolAccounting {
  readonly amountSolLamports: bigint;
  readonly walletDeltaLamports: bigint;
  readonly feeLamports: bigint;
  readonly rentPaidLamports: bigint;
  readonly rentRefundedLamports: bigint;
}

function findWalletIndex(tx: ParsedTransactionWithMeta, wallet: PublicKey): number {
  const walletBase58 = wallet.toBase58();
  return tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === walletBase58);
}

function getWalletOwnedTokenAccountIndexes(tx: ParsedTransactionWithMeta, wallet: PublicKey): Set<number> {
  const walletBase58 = wallet.toBase58();
  const indexes = new Set<number>();

  for (const balance of tx.meta?.preTokenBalances ?? []) {
    if (balance.owner === walletBase58) indexes.add(balance.accountIndex);
  }
  for (const balance of tx.meta?.postTokenBalances ?? []) {
    if (balance.owner === walletBase58) indexes.add(balance.accountIndex);
  }

  return indexes;
}

export function getWalletSolAccountingFromParsedTx(
  tx: ParsedTransactionWithMeta,
  wallet: PublicKey,
): WalletSolAccounting | null {
  const meta = tx.meta;
  if (!meta) return null;

  const walletIndex = findWalletIndex(tx, wallet);
  if (walletIndex < 0) return null;

  const preWallet = BigInt(meta.preBalances[walletIndex] ?? 0);
  const postWallet = BigInt(meta.postBalances[walletIndex] ?? 0);
  const walletDeltaLamports = postWallet - preWallet;
  const feeLamports = BigInt(meta.fee ?? 0);

  const walletOwnedTokenIndexes = getWalletOwnedTokenAccountIndexes(tx, wallet);
  let rentPaidLamports = 0n;
  let rentRefundedLamports = 0n;

  for (const accountIndex of walletOwnedTokenIndexes) {
    if (accountIndex === walletIndex) continue;
    const pre = BigInt(meta.preBalances[accountIndex] ?? 0);
    const post = BigInt(meta.postBalances[accountIndex] ?? 0);
    const delta = post - pre;

    // Token ATA creation rent is paid by the wallet but is not swap cost.
    if (pre === 0n && delta > 0n) {
      rentPaidLamports += delta;
    }

    // If a user-owned token account is closed during the tx, the wallet delta
    // includes this rent refund. It is not swap proceeds.
    if (post === 0n && delta < 0n) {
      rentRefundedLamports += -delta;
    }
  }

  return {
    walletDeltaLamports,
    feeLamports,
    rentPaidLamports,
    rentRefundedLamports,
  };
}

export function deriveBuyAmountSolFromAccounting(accounting: WalletSolAccounting): bigint | null {
  const amount = -accounting.walletDeltaLamports - accounting.feeLamports - accounting.rentPaidLamports + accounting.rentRefundedLamports;
  return amount > 0n ? amount : null;
}

export function deriveSellAmountSolFromAccounting(accounting: WalletSolAccounting): bigint | null {
  const amount = accounting.walletDeltaLamports + accounting.feeLamports - accounting.rentRefundedLamports + accounting.rentPaidLamports;
  return amount > 0n ? amount : null;
}

export async function getConfirmedBuyAmountSol(params: {
  readonly connection: Connection;
  readonly signature: string;
  readonly wallet: PublicKey;
  readonly fallbackLamports: bigint;
  readonly tradeId?: string;
}): Promise<TradeSolAccounting> {
  const tx = await params.connection.getParsedTransaction(params.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const accounting = tx ? getWalletSolAccountingFromParsedTx(tx, params.wallet) : null;
  const amountSolLamports = accounting ? deriveBuyAmountSolFromAccounting(accounting) : null;

  if (!accounting || amountSolLamports === null) {
    logger.warn('Could not derive confirmed BUY SOL amount from transaction meta — using fallback', {
      tradeId: params.tradeId,
      signature: params.signature,
      fallbackLamports: params.fallbackLamports.toString(),
    });
    return {
      amountSolLamports: params.fallbackLamports,
      walletDeltaLamports: -params.fallbackLamports,
      feeLamports: 0n,
      rentPaidLamports: 0n,
      rentRefundedLamports: 0n,
    };
  }

  return { amountSolLamports, ...accounting };
}

export async function getConfirmedSellAmountSol(params: {
  readonly connection: Connection;
  readonly signature: string;
  readonly wallet: PublicKey;
  readonly fallbackLamports: bigint;
  readonly tradeId?: string;
}): Promise<TradeSolAccounting> {
  const tx = await params.connection.getParsedTransaction(params.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const accounting = tx ? getWalletSolAccountingFromParsedTx(tx, params.wallet) : null;
  const amountSolLamports = accounting ? deriveSellAmountSolFromAccounting(accounting) : null;

  if (!accounting || amountSolLamports === null) {
    logger.warn('Could not derive confirmed SELL SOL amount from transaction meta — using fallback', {
      tradeId: params.tradeId,
      signature: params.signature,
      fallbackLamports: params.fallbackLamports.toString(),
    });
    return {
      amountSolLamports: params.fallbackLamports,
      walletDeltaLamports: params.fallbackLamports,
      feeLamports: 0n,
      rentPaidLamports: 0n,
      rentRefundedLamports: 0n,
    };
  }

  return { amountSolLamports, ...accounting };
}
