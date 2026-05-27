/**
 * Signer interface contract.
 *
 * Transaction signing abstraction.
 * Private key: never log, never expose.
 */

import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

/** Signer contract */
export interface ISigner {
  /** Get the public key of the signer */
  getPublicKey(): PublicKey;

  /** Sign a legacy transaction */
  signTransaction(tx: Transaction): Promise<Transaction>;

  /** Sign a versioned transaction */
  signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}
