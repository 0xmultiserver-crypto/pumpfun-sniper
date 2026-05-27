/**
 * Solana program addresses and known accounts.
 *
 * Every address must be verified. No guessed program IDs.
 * Sources documented inline.
 */

import { PublicKey } from '@solana/web3.js';

/**
 * Pump.fun program ID.
 * Source: verified on-chain (mainnet).
 */
export const PUMPFUN_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/**
 * Pump.fun fee recipient account.
 * Source: verified from Pump.fun transaction analysis.
 */
export const PUMPFUN_FEE_RECIPIENT = new PublicKey(
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
);

/**
 * Pump.fun global state account.
 * Source: verified from Pump.fun PDA derivation.
 */
export const PUMPFUN_GLOBAL_STATE = new PublicKey(
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
);

/**
 * Pump.fun event authority.
 * Source: verified from Pump.fun transaction logs.
 */
export const PUMPFUN_EVENT_AUTHORITY = new PublicKey(
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
);

/** Pump.fun global volume accumulator PDA. Source: public Pump.fun IDL. */
export const PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey(
  'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y',
);

/** Pump.fun fee config PDA. Source: public Pump.fun IDL. */
export const PUMPFUN_FEE_CONFIG = new PublicKey(
  '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
);

/** Pump.fun fee program. Source: public Pump.fun IDL. */
export const PUMPFUN_FEE_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
);

/** Pump.fun buyback/creator-fee remaining accounts observed in successful mainnet buys. */
export const PUMPFUN_BUYBACK_FEE_RECIPIENT = new PublicKey(
  'EfL2zfcigafzhU8GDaDm7W7kiaPRvFE5KRwX61k7xDwh',
);

/** System program */
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Token program */
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/** Token-2022 program — Pump.fun migrated newer mints here. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/** Associated Token Account program */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** Metaplex Token Metadata program */
export const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Compute Budget program */
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111',
);

/** Pump.fun token decimals (standard SPL token default for Pump.fun). */
export const PUMPFUN_TOKEN_DECIMALS = 6 as const;
