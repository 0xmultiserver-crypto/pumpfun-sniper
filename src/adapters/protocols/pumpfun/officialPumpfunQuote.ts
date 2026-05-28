import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

import {
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  toBN,
  bnToBigInt,
} from './officialPumpSdk.js';
import { getStaticPumpfunBuybackFeeRecipient } from './pumpfunTradeBuilder.js';

export interface ParsedPumpfunBondingCurveForQuote {
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly complete: boolean;
  readonly creator: PublicKey | null;
}

export interface OfficialPumpfunBondingCurve {
  readonly virtualTokenReserves: BN;
  readonly virtualQuoteReserves: BN;
  readonly realTokenReserves: BN;
  readonly realQuoteReserves: BN;
  readonly tokenTotalSupply: BN;
  readonly complete: boolean;
  readonly creator: PublicKey;
  readonly isMayhemMode: boolean;
  readonly isCashbackCoin: boolean;
  readonly quoteMint: PublicKey;
}

interface PumpfunFeeAccounts {
  readonly feeRecipient: PublicKey;
  readonly buybackFeeRecipient: PublicKey;
}

export interface PumpfunBuyQuote {
  readonly tokenAmount: bigint;
  readonly maxSolCost: bigint;
  readonly feeAccounts: PumpfunFeeAccounts;
}

export interface PumpfunSellQuote {
  readonly expectedSolOutput: bigint;
  readonly minSolOutput: bigint;
  readonly feeAccounts: PumpfunFeeAccounts;
}

export function buildOfficialPumpfunBondingCurve(
  parsed: ParsedPumpfunBondingCurveForQuote,
  mintSupply: bigint | string,
): OfficialPumpfunBondingCurve {
  const supply = toBN(mintSupply);
  return {
    virtualTokenReserves: toBN(parsed.virtualTokenReserves),
    virtualQuoteReserves: toBN(parsed.virtualSolReserves),
    realTokenReserves: toBN(parsed.realTokenReserves),
    realQuoteReserves: toBN(parsed.realSolReserves),
    tokenTotalSupply: supply,
    complete: parsed.complete,
    creator: parsed.creator ?? PublicKey.default,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: NATIVE_MINT,
  };
}

function selectPumpfunFeeAccounts(global: any, mayhemMode = false): PumpfunFeeAccounts {
  const recipients = mayhemMode
    ? [global.reservedFeeRecipient, ...(global.reservedFeeRecipients ?? [])]
    : [global.feeRecipient, ...(global.feeRecipients ?? [])];

  const validRecipients = recipients.filter((recipient: unknown): recipient is PublicKey =>
    recipient instanceof PublicKey && !recipient.equals(PublicKey.default),
  );

  if (validRecipients.length === 0) {
    throw new Error('Pump.fun global fee recipient list is empty');
  }

  return {
    feeRecipient: validRecipients[Math.floor(Math.random() * validRecipients.length)]!,
    buybackFeeRecipient: getStaticPumpfunBuybackFeeRecipient(),
  };
}

export function quoteOfficialPumpfunBuy(params: {
  readonly global: any;
  readonly feeConfig: any | null;
  readonly bondingCurve: OfficialPumpfunBondingCurve;
  readonly mintSupply: BN;
  readonly solBudget: bigint;
  readonly slippageBps: number;
}): PumpfunBuyQuote {
  const tokensOut = getBuyTokenAmountFromSolAmount({
    global: params.global,
    feeConfig: params.feeConfig,
    mintSupply: params.mintSupply,
    bondingCurve: params.bondingCurve,
    amount: toBN(params.solBudget),
    quoteMint: NATIVE_MINT,
  });

  const solCost = getBuySolAmountFromTokenAmount({
    global: params.global,
    feeConfig: params.feeConfig,
    mintSupply: params.mintSupply,
    bondingCurve: params.bondingCurve,
    amount: tokensOut,
    quoteMint: NATIVE_MINT,
  });

  const expectedSolCost = bnToBigInt(solCost);
  const maxSolCost = expectedSolCost + (expectedSolCost * BigInt(params.slippageBps) / 10_000n);

  return {
    tokenAmount: bnToBigInt(tokensOut),
    maxSolCost,
    feeAccounts: selectPumpfunFeeAccounts(params.global, params.bondingCurve.isMayhemMode),
  };
}

export function quoteOfficialPumpfunSell(params: {
  readonly global: any;
  readonly feeConfig: any | null;
  readonly bondingCurve: OfficialPumpfunBondingCurve;
  readonly mintSupply: BN;
  readonly tokenAmount: bigint;
  readonly slippageBps: number;
}): PumpfunSellQuote {
  const sellQuoteSol = getSellSolAmountFromTokenAmount({
    global: params.global,
    feeConfig: params.feeConfig,
    mintSupply: params.mintSupply,
    bondingCurve: params.bondingCurve,
    amount: toBN(params.tokenAmount),
  });
  const expectedSolOutput = bnToBigInt(sellQuoteSol);
  const minSolOutput = expectedSolOutput - (expectedSolOutput * BigInt(params.slippageBps) / 10_000n);

  return {
    expectedSolOutput,
    minSolOutput,
    feeAccounts: selectPumpfunFeeAccounts(params.global, params.bondingCurve.isMayhemMode),
  };
}
