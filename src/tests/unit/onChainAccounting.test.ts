import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  deriveBuyAmountSolFromAccounting,
  deriveSellAmountSolFromAccounting,
  getWalletSolAccountingFromParsedTx,
} from '../../app/execution/onChainAccounting.js';

const WALLET = new PublicKey('DeqVEF81A6DYRK45uWGgj5Gnj57RqeNu5j6mDtVv3Rgy');
const TOKEN_ATA = new PublicKey('7w8YrY5s7j4jTF3jLJ6rRjBVaBGe9z96ZhJSoYYU6RWq');
const OTHER = new PublicKey('11111111111111111111111111111111');

function parsedTx(params: {
  readonly preBalances: number[];
  readonly postBalances: number[];
  readonly fee: number;
  readonly preTokenBalances?: Array<{ accountIndex: number; owner: string }>;
  readonly postTokenBalances?: Array<{ accountIndex: number; owner: string }>;
}) {
  return {
    meta: {
      preBalances: params.preBalances,
      postBalances: params.postBalances,
      fee: params.fee,
      preTokenBalances: params.preTokenBalances ?? [],
      postTokenBalances: params.postTokenBalances ?? [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: WALLET },
          { pubkey: TOKEN_ATA },
          { pubkey: OTHER },
        ],
      },
    },
  } as any;
}

describe('on-chain SOL accounting', () => {
  it('derives BUY swap cost from wallet delta while excluding tx fee and created token-account rent', () => {
    const accounting = getWalletSolAccountingFromParsedTx(
      parsedTx({
        preBalances: [100_000_000, 0, 1],
        postBalances: [86_588_737, 2_074_080, 1],
        fee: 15_000,
        postTokenBalances: [{ accountIndex: 1, owner: WALLET.toBase58() }],
      }),
      WALLET,
    );

    expect(accounting).toEqual({
      walletDeltaLamports: -13_411_263n,
      feeLamports: 15_000n,
      rentPaidLamports: 2_074_080n,
      rentRefundedLamports: 0n,
    });
    expect(deriveBuyAmountSolFromAccounting(accounting!)).toBe(11_322_183n);
  });

  it('derives SELL gross proceeds from wallet delta plus tx fee', () => {
    const accounting = getWalletSolAccountingFromParsedTx(
      parsedTx({
        preBalances: [10_000_000, 2_074_080, 1],
        postBalances: [15_013_926, 2_074_080, 1],
        fee: 15_000,
        preTokenBalances: [{ accountIndex: 1, owner: WALLET.toBase58() }],
        postTokenBalances: [{ accountIndex: 1, owner: WALLET.toBase58() }],
      }),
      WALLET,
    );

    expect(accounting).toEqual({
      walletDeltaLamports: 5_013_926n,
      feeLamports: 15_000n,
      rentPaidLamports: 0n,
      rentRefundedLamports: 0n,
    });
    expect(deriveSellAmountSolFromAccounting(accounting!)).toBe(5_028_926n);
  });

  it('excludes closed token-account rent refunds from SELL proceeds', () => {
    const accounting = getWalletSolAccountingFromParsedTx(
      parsedTx({
        preBalances: [10_000_000, 2_039_280, 1],
        postBalances: [17_024_280, 0, 1],
        fee: 15_000,
        preTokenBalances: [{ accountIndex: 1, owner: WALLET.toBase58() }],
      }),
      WALLET,
    );

    expect(accounting?.rentRefundedLamports).toBe(2_039_280n);
    expect(deriveSellAmountSolFromAccounting(accounting!)).toBe(5_000_000n);
  });
});
