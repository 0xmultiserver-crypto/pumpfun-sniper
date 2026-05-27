/**
 * Unit tests for app/executionDelegate.ts execution safety helpers.
 */

import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { isNonRetryableExecutionError } from '../../app/executionDelegate.js';
import { buildUserAtaCreateInstruction } from '../../execution/tx/ataBuilder.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../core/constants/programs.js';
import { deriveUserATA } from '../../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';

describe('isNonRetryableExecutionError', () => {
  it('treats Pump.fun Custom 6062 buyback fee recipient errors as non-retryable', () => {
    expect(isNonRetryableExecutionError('{"InstructionError":[1,{"Custom":6062}]}')).toBe(true);
  });

  it('treats Pump.fun Custom 2006 seed constraint errors as non-retryable', () => {
    expect(isNonRetryableExecutionError('{"InstructionError":[1,{"Custom":2006}]}')).toBe(true);
  });

  it('treats Pump.fun Custom 3005 instruction errors as non-retryable', () => {
    expect(isNonRetryableExecutionError('{"InstructionError":[1,{"Custom":3005}]}')).toBe(true);
  });

  it('treats Pump.fun Custom 3012 instruction errors as non-retryable', () => {
    expect(isNonRetryableExecutionError('{"InstructionError":[0,{"Custom":3012}]}')).toBe(true);
  });

  it('treats Pump.fun Custom 6024 overflow/slippage errors as non-retryable within one tx attempt', () => {
    expect(isNonRetryableExecutionError('{"InstructionError":[2,{"Custom":6024}]}')).toBe(true);
  });

  it('treats blockhash expiry as retryable', () => {
    expect(isNonRetryableExecutionError('Signature abc has expired: block height exceeded.')).toBe(false);
  });
});

describe('buildUserAtaCreateInstruction', () => {
  it('builds an idempotent ATA create instruction before Pump.fun buy', () => {
    const user = new PublicKey('DeqVEF81A6DYRK45uWGgj5Gnj57RqeNu5j6mDtVv3Rgy');
    const mint = new PublicKey('9k4hSLZoGcHcUYR3gHscyFPoVKUxMLhtcZiFQMD2pump');

    const ix = buildUserAtaCreateInstruction(user, user, mint);

    expect(ix.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    // SPL Associated Token Account instruction 1 = CreateIdempotent.
    expect(ix.data.equals(Buffer.from([1]))).toBe(true);
    expect(ix.keys[0]?.pubkey.toBase58()).toBe(user.toBase58());
    expect(ix.keys[2]?.pubkey.toBase58()).toBe(user.toBase58());
    expect(ix.keys[3]?.pubkey.toBase58()).toBe(mint.toBase58());
    expect(ix.keys[5]?.pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it('uses Token-2022 owner for Token-2022 Pump.fun mints', () => {
    const user = new PublicKey('DeqVEF81A6DYRK45uWGgj5Gnj57RqeNu5j6mDtVv3Rgy');
    const mint = new PublicKey('3JsRpjhhK4RQQFmzXuti1V1EqgCd7WzyeCYqD3FBpump');

    const ix = buildUserAtaCreateInstruction(user, user, mint, TOKEN_2022_PROGRAM_ID);

    expect(ix.keys[1]?.pubkey.toBase58()).toBe(
      deriveUserATA(user, mint, TOKEN_2022_PROGRAM_ID).toBase58(),
    );
    expect(ix.keys[5]?.pubkey.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });
});
