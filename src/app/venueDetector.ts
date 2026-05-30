/**
 * Venue Detector — determines which trading venue a token is on.
 *
 * Checks (in order):
 *   1. PumpFun bonding curve exists + not graduated → 'pumpfun'
 *   2. LaunchLab pool exists + BonkFun platform_config + not graduated → 'bonkfun'
 *   3. Either exists but graduated → 'jupiter'
 *   4. Neither → null
 *
 * App layer — used by executionDelegate and dataProvider for routing.
 */

import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { deriveBondingCurvePDA } from '../adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../adapters/protocols/pumpfun/tokenParser.js';
import { derivePoolStatePDA } from '../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { parsePoolStateData } from '../adapters/protocols/bonkfun/tokenParser.js';
import { BONKFUN_PLATFORM_CONFIG, MIN_BONKFUN_POOL_STATE_SIZE } from '../core/constants/programs.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('app:venueDetector');

export type Venue = 'pumpfun' | 'bonkfun' | 'jupiter';

/**
 * Detect the trading venue for a given token mint.
 *
 * Makes 1-2 RPC calls (PumpFun BC + LaunchLab pool state).
 * Results should be cached by the caller if called frequently.
 *
 * @returns Venue or null if token not found on any known venue.
 */
export async function detectVenue(
  mint: string | PublicKey,
  connection: Connection,
): Promise<Venue | null> {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const mintStr = mintPk.toBase58();

  // Check both PDAs in parallel
  const [bcPDA, poolPDA] = [
    deriveBondingCurvePDA(mintPk),
    derivePoolStatePDA(mintPk),
  ];

  const [bcAccount, poolAccount] = await Promise.all([
    connection.getAccountInfo(bcPDA).catch(() => null),
    connection.getAccountInfo(poolPDA).catch(() => null),
  ]);

  // PumpFun bonding curve check
  if (bcAccount?.data && bcAccount.data.length >= 49) {
    const parsed = parseBondingCurveData(bcAccount.data);
    if (parsed) {
      if (!parsed.complete) {
        logger.debug('Venue detected: pumpfun', { mint: mintStr.slice(0, 12) });
        return 'pumpfun';
      }
      // Graduated from PumpFun → Jupiter
      logger.debug('Venue detected: jupiter (graduated from pumpfun)', { mint: mintStr.slice(0, 12) });
      return 'jupiter';
    }
  }

  // LaunchLab pool check
  if (poolAccount?.data && poolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
    const parsed = parsePoolStateData(Buffer.from(poolAccount.data), mintStr);
    if (parsed) {
      // Verify it's a BonkFun pool (not some other LaunchLab platform)
      if (parsed.platformConfig.equals(BONKFUN_PLATFORM_CONFIG)) {
        if (!parsed.complete) {
          logger.debug('Venue detected: bonkfun', { mint: mintStr.slice(0, 12) });
          return 'bonkfun';
        }
        // Graduated from BonkFun → Jupiter
        logger.debug('Venue detected: jupiter (graduated from bonkfun)', { mint: mintStr.slice(0, 12) });
        return 'jupiter';
      }
    }
  }

  logger.debug('Venue not detected — unknown token', { mint: mintStr.slice(0, 12) });
  return null;
}

/**
 * Detect venue with caching. Useful for repeated calls on the same mint.
 * Cache TTL: 30s (venue doesn't change often, but graduation can happen).
 */
const venueCache = new Map<string, { venue: Venue | null; fetchedAt: number }>();
const VENUE_CACHE_TTL_MS = 30_000;

export async function detectVenueCached(
  mint: string,
  connection: Connection,
): Promise<Venue | null> {
  const cached = venueCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < VENUE_CACHE_TTL_MS) {
    return cached.venue;
  }

  const venue = await detectVenue(mint, connection);
  venueCache.set(mint, { venue, fetchedAt: Date.now() });
  return venue;
}

/**
 * Clear the venue cache (e.g., after detecting graduation).
 */
export function clearVenueCache(mint?: string): void {
  if (mint) {
    venueCache.delete(mint);
  } else {
    venueCache.clear();
  }
}
