/**
 * Pump.fun Token Parser
 *
 * Parse token metadata from on-chain account data (Metaplex format)
 * and bonding curve account data.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import type {
  MintAddress,
  TokenMetadata,
  BondingCurveState,
} from '../../../core/types/token.js';
import { PublicKey } from '@solana/web3.js';
import { createLogger } from '../../../telemetry/logging/logger.js';
import { PUMPFUN_TOKEN_DECIMALS } from '../../../core/constants/programs.js';
import {
  BONDING_CURVE_MIN_LEN,
  PUBKEY_LENGTH,
  readBorshString,
} from './shared.js';

const logger = createLogger('pumpfun:tokenParser');

// ---------------------------------------------------------------------------
// Metaplex Metadata Account Layout (standard, verified)
// ---------------------------------------------------------------------------
//
// Offset 0     : key (u8)
// Offset 1-32  : updateAuthority (32 bytes, PublicKey)
// Offset 33-64 : mint (32 bytes, PublicKey)
// Then borsh-encoded strings: name, symbol, uri
//   Each string: 4-byte LE length prefix, then UTF-8 bytes
//

const OFFSET_MINT = 33;
const OFFSET_NAME_START = 65;
// PUBKEY_LENGTH imported from ./shared.ts

/** Minimum length for a valid Metaplex metadata account. */
const MIN_METADATA_LENGTH = 100;

// ---------------------------------------------------------------------------
// Bonding curve layout (same as pumpfunAdapter — shared reference)
// ---------------------------------------------------------------------------
//
// Offset 0-7  : discriminator (8 bytes, skip)
// Offset 8-15 : virtualTokenReserves (u64 LE)
// Offset 16-23: virtualSolReserves (u64 LE)
// Offset 24-31: realTokenReserves (u64 LE)
// Offset 32-39: realSolReserves (u64 LE)
// Offset 40-47: tokenTotalSupply (u64 LE) — skipped
// Offset 48   : complete (u8, 0 = active, 1 = graduated)
// Offset 49-80: creator (PublicKey) — required by current Pump.fun buy/sell IDL
//

// BONDING_CURVE_MIN_LEN imported from ./shared.ts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a borsh-encoded string from a buffer.
 * Returns the decoded string and the number of bytes consumed (4 + length).
 * Returns null if the buffer is too short.
 */
// readBorshString imported from ./shared.ts

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse token metadata from a Metaplex metadata account buffer.
 *
 * @param accountData  Raw account data from the Metaplex metadata PDA.
 * @param mint         The token's mint address.
 * @returns Parsed metadata, or null if data doesn't match expected format.
 */
export function parseTokenMetadata(
  accountData: Buffer,
  mint: MintAddress,
): TokenMetadata | null {
  if (accountData.length < MIN_METADATA_LENGTH) {
    logger.warn('Metadata account data too short', {
      mint,
      length: accountData.length,
      minExpected: MIN_METADATA_LENGTH,
    });
    return null;
  }

  // Verify the mint in the metadata matches what we expect
  const metadataMint = new PublicKey(
    accountData.subarray(OFFSET_MINT, OFFSET_MINT + PUBKEY_LENGTH),
  ).toBase58();

  if (metadataMint !== mint) {
    logger.warn('Metadata mint mismatch', {
      expected: mint,
      found: metadataMint,
    });
    return null;
  }

  // Parse borsh-encoded strings starting after the mint field
  let cursor = OFFSET_NAME_START;

  const nameResult = readBorshString(accountData, cursor);
  if (nameResult === null) {
    logger.warn('Failed to parse metadata name', { mint });
    return null;
  }
  cursor += nameResult.bytesRead;

  const symbolResult = readBorshString(accountData, cursor);
  if (symbolResult === null) {
    logger.warn('Failed to parse metadata symbol', { mint });
    return null;
  }
  cursor += symbolResult.bytesRead;

  const uriResult = readBorshString(accountData, cursor);
  if (uriResult === null) {
    logger.warn('Failed to parse metadata uri', { mint });
    return null;
  }


  logger.debug('Parsed token metadata', {
    mint,
    name: nameResult.value,
    symbol: symbolResult.value,
  });

  return {
    mint,
    name: nameResult.value,
    symbol: symbolResult.value,
    uri: uriResult.value,
    decimals: PUMPFUN_TOKEN_DECIMALS,
  };
}

/**
 * Parse bonding curve state from raw account data.
 *
 * Pure parsing function — no RPC calls. Returns a partial state object
 * because the mint address and bonding curve address are not encoded in
 * the account data itself.
 *
 * Bonding curve account layout — verified from Pump.fun on-chain program:
 *   Offset 0-7  : discriminator (8 bytes, skip)
 *   Offset 8-15 : virtualTokenReserves (u64 LE)
 *   Offset 16-23: virtualSolReserves (u64 LE)
 *   Offset 24-31: realTokenReserves (u64 LE)
 *   Offset 32-39: realSolReserves (u64 LE)
 *   Offset 40-47: tokenTotalSupply (u64 LE) — skipped
 *   Offset 48   : complete (u8, 0 = active, 1 = graduated)
 */
export function parseBondingCurveData(
  data: Buffer,
): Omit<BondingCurveState, 'mint' | 'bondingCurveAddress'> & { readonly creator: PublicKey | null } | null {
  if (data.length < BONDING_CURVE_MIN_LEN) {
    return null;
  }

  const virtualTokenReserves = data.readBigUInt64LE(8);
  const virtualSolReserves = data.readBigUInt64LE(16);
  const realTokenReserves = data.readBigUInt64LE(24);
  const realSolReserves = data.readBigUInt64LE(32);
  // Offset 40-47: tokenTotalSupply — skipped, we use on-chain supply
  const complete = data.readUInt8(48) === 1;

  const creator = data.length >= 81
    ? new PublicKey(data.subarray(49, 49 + PUBKEY_LENGTH))
    : null;

  return {
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    complete,
    creator,
  };
}
