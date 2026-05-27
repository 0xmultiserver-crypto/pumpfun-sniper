/**
 * Unit tests for the Pump.fun instruction builder.
 */

import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  buildBuyInstruction,
  buildSellInstruction,
  deriveBondingCurvePDA,
  deriveAssociatedBondingCurve,
  deriveCreatorVaultPDA,
  deriveGlobalVolumeAccumulatorPDA,
  deriveUserVolumeAccumulatorPDA,
  deriveBondingCurveV2PDA,
} from '../../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';
import {
  PUMPFUN_EVENT_AUTHORITY,
  PUMPFUN_FEE_CONFIG,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_GLOBAL_STATE,
  PUMPFUN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '../../core/constants/programs.js';

describe('Pump.fun trade builder', () => {
  const mint = new PublicKey('FmzAwgWTug332B9MLprb7QLFExaFJPRgF3UDy81qpump');
  const user = new PublicKey('5t7NEuYXCG5xN788JWPnpnHSZr9LmGj4KaAt85upE8C5');
  const creator = new PublicKey('CYtcqXNyVNjL9wJQPK43ShRMNZtBNrFN9L4ya14nyHEe');
  const bondingCurve = deriveBondingCurvePDA(mint);
  const associatedBondingCurve = deriveAssociatedBondingCurve(bondingCurve, mint, TOKEN_2022_PROGRAM_ID);
  const feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  const buybackFeeRecipient = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

  it('uses the event authority PDA derived from __event_authority', () => {
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PUMPFUN_PROGRAM_ID,
    );

    expect(PUMPFUN_EVENT_AUTHORITY.toBase58()).toBe(eventAuthority.toBase58());
    expect(PUMPFUN_EVENT_AUTHORITY.toBase58()).toBe('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  });

  it('builds the current 18-account Pump.fun BUY instruction from successful mainnet transactions', () => {
    const ix = buildBuyInstruction({
      mint,
      buyer: user,
      bondingCurve,
      associatedBondingCurve,
      tokenAmount: 2_000_000n,
      maxSolCost: 1_000_000n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      creator,
      feeRecipient,
      buybackFeeRecipient,
    });

    expect(ix.programId.toBase58()).toBe(PUMPFUN_PROGRAM_ID.toBase58());
    expect(ix.keys).toHaveLength(18);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      PUMPFUN_GLOBAL_STATE.toBase58(),
      feeRecipient.toBase58(),
      mint.toBase58(),
      bondingCurve.toBase58(),
      associatedBondingCurve.toBase58(),
      '9N8bAAJqi2Xwkj4nNFp47VXZgPTYxkB8B9z8pmpDCMkE',
      user.toBase58(),
      SYSTEM_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      deriveCreatorVaultPDA(creator).toBase58(),
      PUMPFUN_EVENT_AUTHORITY.toBase58(),
      PUMPFUN_PROGRAM_ID.toBase58(),
      deriveGlobalVolumeAccumulatorPDA().toBase58(),
      deriveUserVolumeAccumulatorPDA(user).toBase58(),
      PUMPFUN_FEE_CONFIG.toBase58(),
      PUMPFUN_FEE_PROGRAM_ID.toBase58(),
      deriveBondingCurveV2PDA(mint).toBase58(),
      buybackFeeRecipient.toBase58(),
    ]);
    expect(ix.data.toString('hex')).toBe('66063d1201daebea80841e000000000040420f000000000001');
  });

  it('builds the current 16-account Pump.fun SELL instruction from the public IDL', () => {
    const ix = buildSellInstruction({
      mint,
      seller: user,
      bondingCurve,
      associatedBondingCurve,
      tokenAmount: 2_000_000n,
      minSolOutput: 1_000_000n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      creator,
      feeRecipient,
      buybackFeeRecipient,
    });

    expect(ix.keys).toHaveLength(16);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      PUMPFUN_GLOBAL_STATE.toBase58(),
      feeRecipient.toBase58(),
      mint.toBase58(),
      bondingCurve.toBase58(),
      associatedBondingCurve.toBase58(),
      '9N8bAAJqi2Xwkj4nNFp47VXZgPTYxkB8B9z8pmpDCMkE',
      user.toBase58(),
      SYSTEM_PROGRAM_ID.toBase58(),
      deriveCreatorVaultPDA(creator).toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      PUMPFUN_EVENT_AUTHORITY.toBase58(),
      PUMPFUN_PROGRAM_ID.toBase58(),
      PUMPFUN_FEE_CONFIG.toBase58(),
      PUMPFUN_FEE_PROGRAM_ID.toBase58(),
      deriveBondingCurveV2PDA(mint).toBase58(),
      buybackFeeRecipient.toBase58(),
    ]);
  });
});
