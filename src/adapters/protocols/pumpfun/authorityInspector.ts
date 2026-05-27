/**
 * Token Authority Inspector
 *
 * Inspects SPL Token mint accounts to determine whether mint and freeze
 * authorities have been revoked. Used as a safety check before sniping.
 *
 * For Pump.fun tokens, freeze authority is typically set initially and then
 * revoked after graduation. The minimum safety requirement is that
 * mintAuthority must be revoked.
 */

import { PublicKey } from '@solana/web3.js';

import type { MintAddress, TokenAuthority } from '../../../core/types/token.js';
import type { RpcClient } from '../../../ingestion/rpc/rpcClient.js';
import { createLogger } from '../../../telemetry/logging/logger.js';

const logger = createLogger('pumpfun:authorityInspector');

// ---------------------------------------------------------------------------
// SPL Token Mint Layout Constants (standard, verified)
// ---------------------------------------------------------------------------
//
//   Offset  0–3  : mintAuthorityOption  (u32 LE, 1 = Some, 0 = None)
//   Offset  4–35 : mintAuthority        (32 bytes, PublicKey — only valid if option = 1)
//   Offset 36–43 : supply               (u64 LE)
//   Offset 44    : decimals             (u8)
//   Offset 45    : isInitialized        (u8)
//   Offset 46–49 : freezeAuthorityOption (u32 LE, 1 = Some, 0 = None)
//   Offset 50–81 : freezeAuthority      (32 bytes, PublicKey — only valid if option = 1)
//

const OFFSET_MINT_AUTHORITY_OPTION = 0;
const OFFSET_MINT_AUTHORITY = 4;
const OFFSET_FREEZE_AUTHORITY_OPTION = 46;
const OFFSET_FREEZE_AUTHORITY = 50;

const PUBKEY_LENGTH = 32;

/** The COption<T> value indicating "Some" */
const COPTION_SOME: number = 1;

/** Minimum byte length for a valid SPL Token Mint account */
const MIN_MINT_ACCOUNT_LENGTH = 82;

// ---------------------------------------------------------------------------
// AuthorityInspector
// ---------------------------------------------------------------------------

export class AuthorityInspector {
  private readonly rpcClient: RpcClient;

  constructor(rpcClient: RpcClient) {
    this.rpcClient = rpcClient;
  }

  /**
   * Parse raw SPL Token Mint account data to extract authority status.
   *
   * This is the single source of truth for mint account byte-layout parsing.
   * Use this when you already have the account data (e.g. from a batch fetch)
   * and don't need the RPC call that `inspect()` performs.
   *
   * @throws If the data is too short to be a valid mint account.
   */
  static parseMintBuffer(mint: MintAddress, data: Buffer): TokenAuthority {
    if (data.length < MIN_MINT_ACCOUNT_LENGTH) {
      throw new Error(
        `Mint account data too short: expected >= ${MIN_MINT_ACCOUNT_LENGTH} bytes, got ${data.length}`,
      );
    }

    // Parse mintAuthority option and value
    const mintAuthorityOption = data.readUInt32LE(OFFSET_MINT_AUTHORITY_OPTION);
    const mintAuthorityRevoked = mintAuthorityOption !== COPTION_SOME;
    const mintAuthority = mintAuthorityOption === COPTION_SOME
      ? new PublicKey(
          data.subarray(OFFSET_MINT_AUTHORITY, OFFSET_MINT_AUTHORITY + PUBKEY_LENGTH),
        )
      : null;

    // Parse freezeAuthority option and value
    const freezeAuthorityOption = data.readUInt32LE(OFFSET_FREEZE_AUTHORITY_OPTION);
    const freezeAuthorityRevoked = freezeAuthorityOption !== COPTION_SOME;
    const freezeAuthority = freezeAuthorityOption === COPTION_SOME
      ? new PublicKey(
          data.subarray(OFFSET_FREEZE_AUTHORITY, OFFSET_FREEZE_AUTHORITY + PUBKEY_LENGTH),
        )
      : null;

    return {
      mint,
      mintAuthority,
      freezeAuthority,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
    };
  }

  /**
   * Fetch and parse the mint account to determine authority status.
   *
   * @throws If the mint account does not exist or its data is too short.
   */
  async inspect(mint: MintAddress): Promise<TokenAuthority> {
    const mintPubkey = new PublicKey(mint);

    const accountInfo = await this.rpcClient.getAccountInfo(mintPubkey);

    if (accountInfo === null) {
      throw new Error(`Mint account not found: ${mint}`);
    }

    const data = accountInfo.data as Buffer;
    const authority = AuthorityInspector.parseMintBuffer(mint, data);

    logger.info('Inspected token authority', {
      mint,
      mintAuthorityRevoked: authority.mintAuthorityRevoked,
      freezeAuthorityRevoked: authority.freezeAuthorityRevoked,
      mintAuthority: authority.mintAuthority?.toBase58() ?? null,
      freezeAuthority: authority.freezeAuthority?.toBase58() ?? null,
    });

    return authority;
  }

  /**
   * Determine whether a token's authority configuration is safe for trading.
   *
   * For Pump.fun tokens, freeze authority is typically set initially and then
   * revoked after graduation. The critical safety requirement is that
   * mintAuthority MUST be revoked (prevents further minting / inflation).
   *
   * Returns `true` if:
   * - BOTH mint and freeze authorities are revoked (safest), OR
   * - mintAuthority alone is revoked (acceptable for Pump.fun tokens where
   *   freeze authority may still be present initially)
   */
  isSafe(authority: TokenAuthority): boolean {
    if (!authority.mintAuthorityRevoked) {
      logger.warn('Token mint authority NOT revoked — unsafe', {
        mint: authority.mint,
        mintAuthority: authority.mintAuthority?.toBase58() ?? null,
      });
      return false;
    }

    if (!authority.freezeAuthorityRevoked) {
      logger.debug('Token freeze authority still active — acceptable for Pump.fun', {
        mint: authority.mint,
        freezeAuthority: authority.freezeAuthority?.toBase58() ?? null,
      });
    }

    return true;
  }
}
