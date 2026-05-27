/**
 * Keypair Signer
 *
 * ISigner implementation backed by a Solana Keypair.
 *
 * CRITICAL SECURITY:
 *   - Private key is NEVER logged
 *   - Private key is NEVER serialized
 *   - Keypair is stored in memory only
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { ISigner } from '../../core/interfaces/signer.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:keypairSigner');

// ---------------------------------------------------------------------------
// KeypairSigner
// ---------------------------------------------------------------------------

export class KeypairSigner implements ISigner {
  private readonly keypair: Keypair;

  /**
   * Create a signer from a Keypair.
   *
   * SECURITY: The keypair's secret key is stored in memory only.
   * It is NEVER logged or serialized.
   */
  constructor(keypair: Keypair) {
    this.keypair = keypair;
    logger.info('Keypair signer initialized', {
      publicKey: keypair.publicKey.toBase58(),
    });
  }

  /**
   * Create a signer from a base58-encoded secret key.
   */
  static fromSecretKey(secretKey: Uint8Array): KeypairSigner {
    const keypair = Keypair.fromSecretKey(secretKey);
    return new KeypairSigner(keypair);
  }

  getPublicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.partialSign(this.keypair);
    return tx;
  }

  async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}
