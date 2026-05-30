import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { buildPumpfunSellInstructions, executeSell } from '../../app/execution/sellExecutor.js';
import type { ExecutionRuntime } from '../../app/execution/runtime.js';
import { PositionRegistry } from '../../core/state/positionRegistry.js';
import type { MintAddress } from '../../core/types/token.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../core/constants/programs.js';

const USER = new PublicKey('DeqVEF81A6DYRK45uWGgj5Gnj57RqeNu5j6mDtVv3Rgy');
const MINT = '9UAtAfRssnU4sG1yjemdYYR3qNmCbXQtVHe44vfPpump' as MintAddress;

function makeRuntime(registry: PositionRegistry): ExecutionRuntime {
  return {
    container: {
      signer: { getPublicKey: () => USER },
      connection: {
        getAccountInfo: async () => null,
      },
      tradeRepository: {
        save: async () => undefined,
      },
      cooldownManager: {
        activateCooldown: () => undefined,
        activateCooldownForDuration: () => undefined,
      },
      dailyLossGuard: {
        recordTrade: () => undefined,
      },
      solPriceOracle: {
        getSolPriceUsd: async () => 150,
      },
    },
    positionRegistry: registry,
    pumpSdk: {},
    maxTxRetries: 0,
    retryDelayMs: 0,
    nextTradeId: () => 'unused',
    delay: async () => undefined,
    isPermanentError: () => false,
    getMintTokenProgram: async () => TOKEN_PROGRAM_ID,
    getUserTokenBalance: async () => 0n,
    confirmSubmittedTransaction: async () => null,
    computePositionSizeLamports: () => 0n,
  } as unknown as ExecutionRuntime;
}

describe('executeSell', () => {
  it('builds Token-2022 Pump.fun sells with the official V2 sell instruction and WSOL unwrap', async () => {
    let v2Called = false;
    const v2Ix = new TransactionInstruction({
      programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
      keys: [],
      data: Buffer.from([1, 2, 3]),
    });
    const runtime = {
      container: {
        pumpfunVenue: {
          buildSwap: () => {
            throw new Error('legacy sell builder must not be used for Token-2022 Pump.fun mints');
          },
        },
      },
      pumpSdk: {
        getSellV2InstructionRaw: async (params: any) => {
          v2Called = true;
          expect(params.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
          expect(params.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
          expect(params.amount.toString()).toBe('1234');
          expect(params.quoteAmount.toString()).toBe('567');
          return v2Ix;
        },
      },
    } as unknown as ExecutionRuntime;

    const instructions = await buildPumpfunSellInstructions({
      runtime,
      mint: new PublicKey(MINT),
      user: USER,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenAmount: 1234n,
      minSolOutput: 567n,
      creator: USER,
      feeRecipient: USER,
      buybackFeeRecipient: USER,
    });

    expect(v2Called).toBe(true);
    expect(instructions).toHaveLength(5);
    expect(instructions[3]).toBe(v2Ix);
  });

  it('closes an open position without sending a tx when wallet token balance is already zero', async () => {
    const registry = new PositionRegistry();
    registry.register({
      id: 'buy-1',
      mint: MINT,
      status: 'ENTERED',
      tradeId: 'buy-1',
      entryAmountSol: 1_000_000n,
      entryAmountTokens: 1_000n,
      entryPriceSol: 1_000n,
      entryTimestamp: 1_000,
      currentPnlPercent: null,
      exitReason: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const result = await executeSell(
      { tradeId: 'buy-1', mint: MINT, reason: 'TIMEOUT', slippageBps: 500 },
      makeRuntime(registry),
    );

    expect(result).toEqual({ success: true, signature: null, error: null });
    expect(registry.get('buy-1')?.status).toBe('EXITED');
    expect(registry.getActiveCount()).toBe(0);
    expect(registry.getTransitions('buy-1')).toEqual([
      expect.objectContaining({
        from: 'ENTERED',
        to: 'EXITED',
        reason: 'NO_TOKEN_BALANCE',
      }),
    ]);
  });
});
