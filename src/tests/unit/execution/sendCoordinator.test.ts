/**
 * Unit tests for execution/sender/sendCoordinator.ts
 *
 * Regression: duplicate send attempts must not look successful.
 * If an on-chain failure retries within the dedupe TTL, returning
 * { sendResult: null, error: null } lets callers skip confirmation and
 * incorrectly mark BUY/SELL as successful.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { SendCoordinator } from '../../../execution/sender/sendCoordinator.js';
import type { ISigner } from '../../../core/interfaces/signer.js';
import type { RpcSender } from '../../../execution/sender/rpcSender.js';

function makeSigner() {
  return {
    getPublicKey: vi.fn(() => ({}) as PublicKey),
    signTransaction: vi.fn(async (tx: Transaction) => tx),
    signVersionedTransaction: vi.fn(async (tx: VersionedTransaction) => tx),
  } satisfies ISigner;
}

function makeSender() {
  return {
    send: vi.fn(async () => ({
      signature: 'sig-1',
      sentAt: 123,
      slot: null,
    })),
  } as unknown as RpcSender;
}

describe('SendCoordinator', () => {
  it('returns an error for duplicate trade IDs so callers cannot treat skipped sends as success', async () => {
    const signer = makeSigner();
    const sender = makeSender();
    const coordinator = new SendCoordinator(signer, sender, { dedupeTtlMs: 30_000 });
    const transaction = {} as VersionedTransaction;

    const first = await coordinator.signAndSend({ tradeId: 'trade-1', transaction });
    const duplicate = await coordinator.signAndSend({ tradeId: 'trade-1', transaction });

    expect(first.error).toBeNull();
    expect(first.sendResult?.signature).toBe('sig-1');
    expect(duplicate.isDuplicate).toBe(true);
    expect(duplicate.sendResult).toBeNull();
    expect(duplicate.error).toContain('Duplicate trade detected');
    expect(signer.signVersionedTransaction).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledTimes(1);

    coordinator.destroy();
  });
});
