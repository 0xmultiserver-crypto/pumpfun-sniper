/**
 * LaunchLab Log Parser — Detect new BonkFun token launches from Raydium LaunchLab logs.
 *
 * When the bot subscribes to RAYDIUM_LAUNCHLAB_PROGRAM_ID logs, this parser
 * identifies `initialize` / `initialize_with_token_2022` instructions,
 * verifies the platform_config is BonkFun, and extracts the token mint.
 *
 * Adapter layer: protocol integration ONLY. No strategy logic.
 *
 * Flow:
 *   1. Check if logs mention LaunchLab program ID
 *   2. Look for "Initialize" instruction pattern in log lines
 *   3. Fetch full transaction to get instruction accounts
 *   4. Verify platform_config === BONKFUN_PLATFORM_CONFIG
 *   5. Extract base_token_mint as the new token
 */

import type { Connection, TransactionResponse, VersionedTransactionResponse } from '@solana/web3.js';
import type { LaunchEvent } from '../../../core/types/signal.js';
import {
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  BONKFUN_PLATFORM_CONFIG,
} from '../../../core/constants/programs.js';
import { createLogger } from '../../../telemetry/logging/logger.js';

const logger = createLogger('adapters:bonkfun:launchLabParser');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** LaunchLab program ID as base58 string (cached for fast comparison). */
const LAUNCHLAB_PROGRAM_ID_STR = RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58();

/** BonkFun platform config as base58 string (cached). */
const BONKFUN_PLATFORM_CONFIG_STR = BONKFUN_PLATFORM_CONFIG.toBase58();

/**
 * Log patterns that indicate a LaunchLab pool initialization.
 * Anchor programs emit: "Program log: Instruction: <Name>"
 *
 * LaunchLab IDL instruction names for pool creation:
 *   - "Initialize" (standard SPL token)
 *   - "InitializeWithToken2022" (Token-2022 variant)
 */
const INITIALIZE_PATTERNS = [
  'Instruction: Initialize',
  'Instruction: InitializeV2',
  'Instruction: InitializeWithToken2022',
  'Instruction: CreatePool',  // possible alias
] as const;

/**
 * Account indices in the LaunchLab `initialize` instruction (from IDL).
 *
 * V1 (deprecated):
 *   #0  creator (signer, writable)
 *   #1  authority PDA
 *   #2  global_config
 *   #3  platform_config
 *   #4  pool_state (writable)
 *   #5  base_token_mint    ← V1 MINT INDEX
 *   #6  quote_token_mint (WSOL)
 *   ...
 *
 * V2 (current):
 *   #0  payer (signer, writable)
 *   #1  creator
 *   #2  configId (global config)
 *   #3  platformId (platform config)
 *   #4  auth (authority PDA)
 *   #5  poolId (pool state, writable)
 *   #6  mintA (base token mint)    ← V2 MINT INDEX
 *   #7  mintB (quote token mint / WSOL)
 *   ...
 */
const ACCOUNT_IDX_PLATFORM_CONFIG = 3;
const ACCOUNT_IDX_BASE_TOKEN_MINT_V1 = 5;
const ACCOUNT_IDX_BASE_TOKEN_MINT_V2 = 6;

/** WSOL mint address (cached for V1/V2 detection). */
const WSOL_MINT_STR = 'So11111111111111111111111111111111111111112';

/**
 * Minimum accounts for a valid initialize instruction.
 * V1 needs 9 accounts (through quote_vault), V2 needs 10.
 */
const MIN_INITIALIZE_ACCOUNTS = 9;

// ---------------------------------------------------------------------------
// Synchronous check (fast — no network calls)
// ---------------------------------------------------------------------------

/**
 * Quick synchronous check: do these logs look like a LaunchLab initialize?
 *
 * Checks:
 *   1. Any log line mentions the LaunchLab program ID
 *   2. Any log line matches an "Initialize" instruction pattern
 *
 * @returns true if the logs are a candidate for BonkFun launch.
 */
export function isLaunchLabInitializeCandidate(
  logs: readonly string[],
): boolean {
  let hasLaunchLab = false;
  let hasInitialize = false;

  for (const line of logs) {
    if (!hasLaunchLab && line.includes(LAUNCHLAB_PROGRAM_ID_STR)) {
      hasLaunchLab = true;
    }
    if (!hasInitialize) {
      for (const pattern of INITIALIZE_PATTERNS) {
        if (line.includes(pattern)) {
          hasInitialize = true;
          break;
        }
      }
    }
    if (hasLaunchLab && hasInitialize) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Async verification (fetches transaction)
// ---------------------------------------------------------------------------

/**
 * Fetch the transaction and verify it's a BonkFun pool initialization.
 *
 * Steps:
 *   1. Fetch full transaction by signature
 *   2. Find the LaunchLab instruction
 *   3. Check platform_config account === BONKFUN_PLATFORM_CONFIG
 *   4. Extract base_token_mint
 *
 * @returns Parsed LaunchEvent if verified BonkFun launch, null otherwise.
 */
export async function verifyAndParseLaunchLabTx(
  signature: string,
  slot: number,
  connection: Connection,
): Promise<LaunchEvent | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || !tx.meta) {
      logger.debug('Transaction fetch failed — no tx or meta', {
        signature,
        hasTx: !!tx,
      });
      return null;
    }

    // Note: tx.meta.err may be non-null if a LATER instruction in the same tx failed
    // (e.g. a Jupiter aggregator call after the LaunchLab InitializeV2 succeeded).
    // We still process the tx — the LaunchLab instruction may have succeeded.
    if (tx.meta.err !== null) {
      logger.debug('TX has error but will check LaunchLab instruction anyway', {
        signature,
        err: tx.meta.err,
      });
    }

    // Extract account keys (handle both legacy and versioned transactions)
    const accountKeys = extractAccountKeys(tx);
    if (accountKeys.length === 0) {
      logger.debug('No account keys found', { signature });
      return null;
    }

    // Find the LaunchLab instruction
    // Handle both legacy (Message) and versioned (MessageV0) transactions
    // Legacy: message.instructions (uses .accounts)
    // Versioned: message.compiledInstructions (uses .accountKeyIndexes)
    const message = tx.transaction.message as unknown as Record<string, unknown>;
    const rawInstructions = (message.instructions ?? message.compiledInstructions) as
      | Record<string, unknown>[]
      | undefined;

    if (!rawInstructions || !Array.isArray(rawInstructions)) {
      logger.debug('No instructions found in transaction', { signature });
      return null;
    }

    for (const ix of rawInstructions) {
      const programIdIndex = ix.programIdIndex as number;
      const programId = accountKeys[programIdIndex];
      if (programId !== LAUNCHLAB_PROGRAM_ID_STR) continue;

      // This is a LaunchLab instruction
      // V0 compiled: accountKeyIndexes, Legacy: accounts
      const ixAccounts = (ix.accountKeyIndexes ?? ix.accounts) as readonly number[] | undefined;

      if (!ixAccounts || ixAccounts.length < MIN_INITIALIZE_ACCOUNTS) {
        logger.debug('Instruction has too few accounts for initialize', {
          signature,
          accountCount: ixAccounts?.length ?? 0,
        });
        continue;
      }

      // Check platform_config
      const platformConfigIdx = ixAccounts[ACCOUNT_IDX_PLATFORM_CONFIG];
      if (platformConfigIdx === undefined) continue;
      const platformConfig = accountKeys[platformConfigIdx];

      if (platformConfig !== BONKFUN_PLATFORM_CONFIG_STR) {
        logger.debug('Platform config mismatch — not BonkFun', {
          signature,
          platformConfig,
          expected: BONKFUN_PLATFORM_CONFIG_STR,
        });
        continue;
      }

      // Extract base_token_mint
      // V1 layout: mint at index #5, V2 layout: mint at index #6
      // Detect by checking if index #5 is WSOL (V2) or not (V1)
      let mintIdx = ixAccounts[ACCOUNT_IDX_BASE_TOKEN_MINT_V1];
      if (mintIdx !== undefined) {
        const candidateMint = accountKeys[mintIdx];
        if (candidateMint === WSOL_MINT_STR) {
          // V2 layout — mint is at index #6
          mintIdx = ixAccounts[ACCOUNT_IDX_BASE_TOKEN_MINT_V2];
        }
      }
      if (mintIdx === undefined) continue;
      const mint = accountKeys[mintIdx];

      if (!mint) {
        logger.debug('Could not extract mint from instruction accounts', {
          signature,
          mintIdx,
        });
        continue;
      }

      // Extract creator (account #0)
      const creatorIdx = ixAccounts[0];
      const creator = (creatorIdx !== undefined ? accountKeys[creatorIdx] : undefined) ?? '';

      logger.info('BonkFun launch verified', {
        mint,
        creator,
        slot,
        signature: signature.slice(0, 16),
      });

      return {
        mint,
        creator,
        name: '',    // LaunchLab doesn't emit name/symbol in tx logs
        symbol: '',
        uri: '',
        slot,
        signature,
        timestamp: Date.now(),
      };
    }

    logger.debug('No matching LaunchLab initialize instruction found', {
      signature,
    });
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error verifying LaunchLab transaction', { signature, error: msg });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract account key strings from a transaction response.
 * Handles both legacy and versioned (v0) transaction formats.
 * Versioned tx: static keys + loaded addresses (writable + readonly).
 */
function extractAccountKeys(
  tx: TransactionResponse | VersionedTransactionResponse,
): string[] {
  const keys: string[] = [];

  // Both legacy and versioned tx have accountKeys but at different paths.
  // Legacy: tx.transaction.message.accountKeys (array of PublicKey)
  // Versioned (v0): tx.transaction.message.staticAccountKeys (array of PublicKey)
  // Helius enhanced: tx.transaction.accountKeys (array of strings)
  // Try multiple access patterns.
  const msg = tx.transaction.message as unknown as Record<string, unknown>;
  const txObj = tx.transaction as unknown as Record<string, unknown>;

  // Pattern 1: message.accountKeys (legacy)
  // Pattern 2: message.staticAccountKeys (versioned v0)
  // Pattern 3: transaction.accountKeys (Helius enhanced format)
  const rawKeys = (msg.accountKeys ?? msg.staticAccountKeys ?? txObj.accountKeys) as
    | { toString(): string }[]
    | undefined;

  if (rawKeys && Array.isArray(rawKeys)) {
    for (const key of rawKeys) {
      keys.push(typeof key === 'string' ? key : key.toString());
    }
  }

  // For versioned transactions (v0), append loaded addresses from meta
  const meta = tx.meta;
  if (meta?.loadedAddresses) {
    const loaded = meta.loadedAddresses;
    if (loaded.writable) {
      for (const key of loaded.writable) {
        keys.push(typeof key === 'string' ? key : key.toString());
      }
    }
    if (loaded.readonly) {
      for (const key of loaded.readonly) {
        keys.push(typeof key === 'string' ? key : key.toString());
      }
    }
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Trade event detection (BuyExactIn / SellExactIn)
// ---------------------------------------------------------------------------

const BUY_EXACT_IN_PATTERN = 'Instruction: BuyExactIn';
const SELL_EXACT_IN_PATTERN = 'Instruction: SellExactIn';

/** Check if logs contain a LaunchLab BuyExactIn instruction. */
export function isLaunchLabBuyExactIn(logs: readonly string[]): boolean {
  return logs.some(l => l.includes(BUY_EXACT_IN_PATTERN));
}

/** Check if logs contain a LaunchLab SellExactIn instruction. */
export function isLaunchLabSellExactIn(logs: readonly string[]): boolean {
  return logs.some(l => l.includes(SELL_EXACT_IN_PATTERN));
}

/**
 * Extract the base token mint from a LaunchLab trade transaction.
 * Fetches the tx and finds the LaunchLab instruction's base_mint account.
 *
 * BuyExactIn / SellExactIn account layout (same 18 accounts):
 *   #0  payer, #1  authority, #2  global_config, #3  platform_config,
 *   #4  pool_state, #5  user_base_token, #6  user_quote_token,
 *   #7  base_vault, #8  quote_vault, #9  base_token_mint, #10  quote_token_mint
 *
 * @returns mint address string, or null if extraction fails.
 */
export async function extractMintFromLaunchLabTx(
  signature: string,
  connection: Connection,
): Promise<string | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || !tx.meta) return null;

    const accountKeys = extractAccountKeys(tx);
    if (accountKeys.length === 0) return null;

    const message = tx.transaction.message as unknown as Record<string, unknown>;
    const rawInstructions = (message.instructions ?? message.compiledInstructions) as
      | Record<string, unknown>[]
      | undefined;

    if (!rawInstructions) return null;

    for (const ix of rawInstructions) {
      const programIdIndex = ix.programIdIndex as number;
      if (accountKeys[programIdIndex] !== LAUNCHLAB_PROGRAM_ID_STR) continue;

      const ixAccounts = (ix.accountKeyIndexes ?? ix.accounts) as readonly number[] | undefined;
      if (!ixAccounts || ixAccounts.length < 10) continue;

      // base_token_mint is at account index #9 for buy/sell instructions
      const mintIdx = ixAccounts[9];
      if (mintIdx === undefined) continue;
      const mint = accountKeys[mintIdx];
      if (mint && mint !== WSOL_MINT_STR) return mint;
    }

    return null;
  } catch {
    return null;
  }
}
