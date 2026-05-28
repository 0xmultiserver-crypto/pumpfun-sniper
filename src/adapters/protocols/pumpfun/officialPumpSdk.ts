import { createRequire } from 'node:module';
import BN from 'bn.js';

const require = createRequire(import.meta.url);
// Use the official SDK's CommonJS entry. Its ESM entry currently trips over a
// transitive agent-payments named export, while CJS loads correctly under Node.
// Keep this wrapper narrow so the rest of the codebase still uses typed local APIs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pumpSdk = require('@pump-fun/pump-sdk');

export const PumpSdk = pumpSdk.PumpSdk as new () => any;
export const GLOBAL_PDA = pumpSdk.GLOBAL_PDA;
export const PUMP_FEE_CONFIG_PDA = pumpSdk.PUMP_FEE_CONFIG_PDA;
export const getBuyTokenAmountFromSolAmount = pumpSdk.getBuyTokenAmountFromSolAmount as (args: {
  global: any;
  feeConfig: any | null;
  mintSupply: BN | null;
  bondingCurve: any | null;
  amount: BN;
  quoteMint: any;
}) => BN;

export const getBuySolAmountFromTokenAmount = pumpSdk.getBuySolAmountFromTokenAmount as (args: {
  global: any;
  feeConfig: any | null;
  mintSupply: BN | null;
  bondingCurve: any | null;
  amount: BN;
  quoteMint: any;
}) => BN;

export const getSellSolAmountFromTokenAmount = pumpSdk.getSellSolAmountFromTokenAmount as (args: {
  global: any;
  feeConfig: any | null;
  mintSupply: BN;
  bondingCurve: any;
  amount: BN;
}) => BN;

export function toBN(value: bigint | string | number): BN {
  return new BN(value.toString());
}

export function bnToBigInt(value: BN): bigint {
  return BigInt(value.toString());
}
