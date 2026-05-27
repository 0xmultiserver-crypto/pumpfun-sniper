/**
 * Data Provider — fetches on-chain data for entry checks + position monitoring.
 *
 * Extracted from main.ts. Pure data-fetching, no execution logic.
 */

import { PublicKey } from '@solana/web3.js';
import type { ServiceContainer } from './container.js';
import type { StrategyDataProvider } from '../strategies/filteredSniper/filteredSniperStrategy.js';
import type { EntryCheckData } from '../strategies/filteredSniper/entryDecision.js';
import type { PositionData } from '../strategies/filteredSniper/exitDecision.js';
import type { MintAddress } from '../core/types/token.js';
import type { Signal, LaunchSignal } from '../core/types/signal.js';
import type { WalletAddress } from '../core/types/wallet.js';
import type { PositionRegistry } from '../core/state/positionRegistry.js';
import { createLogger } from '../telemetry/logging/logger.js';
import { deriveBondingCurvePDA } from '../adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../adapters/protocols/pumpfun/tokenParser.js';
import { METADATA_PROGRAM_ID } from '../core/constants/programs.js';
import {
  CREATOR_HISTORY_MAX_LAUNCHES,
  CREATOR_HISTORY_WINDOW_MS,
} from '../strategies/filteredSniper/filteredSniperRules.js';
import { computePositionSizeLamports } from './executionDelegate.js';
import {
  evaluateAuthority,
  evaluateLiquidity,
  evaluateLaunchProvenance,
  evaluateMetadata,
  evaluateConcentration,
} from './entryCheckEvaluator.js';

const logger = createLogger('main:dataProvider');

/** In-memory highest price tracking per trade. */
const highestPriceTracker = new Map<string, bigint>();

// Metaplex Token Metadata PDA
function deriveMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Real Data Provider — fetches on-chain data for 9 entry checks
 * + tracks open positions for exit evaluation.
 */
export function createDataProvider(
  container: ServiceContainer,
  positionRegistry: PositionRegistry,
): StrategyDataProvider {
  const conn = container.connection;

  // In-memory caches (per session)
  const metadataCache = new Map<string, { name: string; symbol: string; uri: string } | null>();

  return {
    async getEntryCheckData(signal: Signal): Promise<EntryCheckData> {
      const mint = signal.mint;
      const mintPk = new PublicKey(mint);
      const results = await Promise.allSettled([
        // Fetch 1: Token Mint account (authority checks)
        conn.getAccountInfo(mintPk),
        // Fetch 2: Bonding curve account (liquidity + creator fallback)
        conn.getAccountInfo(deriveBondingCurvePDA(mintPk)),
        // Fetch 3: Metaplex metadata account (metadata check)
        conn.getAccountInfo(deriveMetadataPDA(mintPk)),
        // Fetch 4: Token largest accounts (wallet concentration)
        conn.getTokenLargestAccounts(mintPk),
        // Fetch 5: Token supply
        conn.getTokenSupply(mintPk),
        // Fetch 6: Previously persisted signals for launch provenance
        container.signalRepository.findByMint(mint),
      ]);

      const signalsForMint = results[5].status === 'fulfilled' ? results[5].value : [];
      if (results[5].status === 'rejected') {
        logger.warn('Failed to load signal history for entry checks', {
          mint: mint.slice(0, 12),
          error: results[5].reason instanceof Error ? results[5].reason.message : String(results[5].reason),
        });
      }

      const launchSignals = signalsForMint.filter((item): item is LaunchSignal => item.type === 'LAUNCH');
      const latestLaunch = launchSignals[launchSignals.length - 1] ?? null;

      const mintAccount = results[0].status === 'fulfilled' ? results[0].value : null;
      const { mintAuthorityRevoked, freezeAuthorityRevoked } = evaluateAuthority(mint, mintAccount);

      const bondingCurveAccount = results[1].status === 'fulfilled' ? results[1].value : null;
      const { liquiditySane, bondingCurveCreator } = evaluateLiquidity(bondingCurveAccount);

      const creatorAddress = (latestLaunch?.creator ?? bondingCurveCreator) as WalletAddress | null;
      const launchDetected = evaluateLaunchProvenance(launchSignals, liquiditySane, creatorAddress);

      // --- Check 2: Creator not blacklisted ---
      const creatorNotBlacklisted = creatorAddress !== null
        ? !container.creatorBlacklist.isBlacklisted(creatorAddress)
        : false;

      // --- Check 3: Creator history acceptable ---
      let creatorHistoryAcceptable = false;
      let creatorLaunchCount = 0;
      if (creatorAddress !== null) {
        try {
          const launches = await container.signalRepository.findRecentLaunchesByCreator(
            creatorAddress,
            signal.timestamp - CREATOR_HISTORY_WINDOW_MS,
          );
          creatorLaunchCount = launches.length;
          creatorHistoryAcceptable = creatorLaunchCount <= CREATOR_HISTORY_MAX_LAUNCHES;
        } catch (err: unknown) {
          logger.warn('Failed to load creator history for entry checks', {
            mint: mint.slice(0, 12),
            creator: creatorAddress.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
          creatorHistoryAcceptable = false;
        }
      }

      const metadataAccount = results[2].status === 'fulfilled' ? results[2].value : null;
      const { metadataSane, parsed: metadataParsed } = evaluateMetadata(mint, metadataAccount, mintAccount);
      if (metadataParsed) {
        metadataCache.set(mint, metadataParsed);
      }

      const largestAccounts = results[3].status === 'fulfilled' ? results[3].value : null;
      const supply = results[4].status === 'fulfilled' ? results[4].value : null;
      const walletConcentrationAcceptable = evaluateConcentration(
        largestAccounts?.value ?? null,
        supply?.value.amount ?? null,
      );

      // --- Check 9: Momentum data from the actual MOMENTUM signal payload ---
      const buyCountInWindow = signal.type === 'MOMENTUM' ? signal.buyCount : 0;
      const volumeLamports = signal.type === 'MOMENTUM' ? signal.volumeSol : 0n;
      const windowMs = signal.type === 'MOMENTUM' ? signal.windowSeconds * 1000 : Number.POSITIVE_INFINITY;

      // --- Check 10: Price impact of position size on bonding curve ---
      let priceImpactBps: number | null = null;
      if (bondingCurveAccount?.data && bondingCurveAccount.data.length >= 49) {
        const parsed = parseBondingCurveData(bondingCurveAccount.data);
        if (parsed && parsed.virtualSolReserves > 0n) {
          try {
            const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
            const positionSizeLamports = computePositionSizeLamports(solPriceUsd);
            priceImpactBps = Number((positionSizeLamports * 10000n) / (parsed.virtualSolReserves + positionSizeLamports));
          } catch (err: unknown) {
            logger.warn('Failed to compute price impact — SOL price unavailable', {
              mint: mint.slice(0, 12),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // --- Creator score from historical performance ---
      let creatorScore: number | null = null;
      if (creatorAddress !== null) {
        try {
          creatorScore = await container.creatorStatsRepository.getScore(creatorAddress);
        } catch (err: unknown) {
          logger.warn('Failed to load creator score', {
            mint: mint.slice(0, 12),
            creator: creatorAddress.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('Entry check data fetched', {
        mint: mint.slice(0, 12),
        signalType: signal.type,
        launchDetected,
        creator: creatorAddress?.slice(0, 12) ?? null,
        creatorLaunchCount,
        creatorScore,
        mintAuthorityRevoked,
        freezeAuthorityRevoked,
        metadataSane,
        liquiditySane,
        walletConcentrationAcceptable,
        creatorNotBlacklisted,
        priceImpactBps,
      });

      return {
        mint,
        launchDetected,
        creatorNotBlacklisted,
        creatorHistoryAcceptable,
        creatorScore,
        mintAuthorityRevoked,
        freezeAuthorityRevoked,
        metadataSane,
        liquiditySane,
        walletConcentrationAcceptable,
        buyCountInWindow,
        volumeLamports,
        windowMs,
        priceImpactBps,
      };
    },

    async getPositionData(tradeId: string): Promise<PositionData | null> {
      const pos = positionRegistry.get(tradeId);
      if (!pos) return null;

      // Fetch current price from bonding curve
      const mintPk = new PublicKey(pos.mint);
      const bcPDA = deriveBondingCurvePDA(mintPk);
      const bcAccount = await conn.getAccountInfo(bcPDA);

      let currentPriceLamports = 0n;
      let graduated = false;
      if (bcAccount?.data && bcAccount.data.length >= 49) {
        const parsed = parseBondingCurveData(bcAccount.data);
        if (parsed) {
          graduated = parsed.complete;
          if (!graduated && parsed.virtualTokenReserves > 0n) {
            currentPriceLamports = (parsed.virtualSolReserves * 10n ** 9n) / parsed.virtualTokenReserves;
          }
        }
      }

      // Track highest price for trailing stop
      const posTradeId = pos.tradeId ?? pos.id;
      const prevHighest = highestPriceTracker.get(posTradeId) ?? 0n;
      const highestPriceLamports = currentPriceLamports > prevHighest ? currentPriceLamports : prevHighest;
      if (highestPriceLamports > prevHighest) {
        highestPriceTracker.set(posTradeId, highestPriceLamports);
      }

      return {
        mint: pos.mint as MintAddress,
        tradeId: posTradeId,
        entryPriceLamports: pos.entryPriceSol ?? 0n,
        currentPriceLamports,
        openedAt: pos.entryTimestamp ?? pos.createdAt,
        killSwitchActive: !container.killSwitch.isAlive(),
        graduated,
        highestPriceLamports,
      };
    },

    getActivePositionCount(): number {
      return positionRegistry.getActiveCount();
    },
  };
}
