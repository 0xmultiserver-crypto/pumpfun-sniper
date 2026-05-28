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
import { nowMs } from '../core/utils/time.js';
import {
  CREATOR_HISTORY_MAX_LAUNCHES,
  CREATOR_HISTORY_WINDOW_MS,
} from '../strategies/filteredSniper/filteredSniperRules.js';
import { computePositionSizeLamports } from './executionDelegate.js';
import { getRealHolderCount } from './heliusHolderCount.js';
import { getRealVolume1h } from './realVolumeFetcher.js';
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

/** Jupiter price cache per mint (price in SOL per raw token). Avoids hammering API every 1s poll. */
const graduatedPriceCache = new Map<string, { priceLamports: bigint; fetchedAt: number }>();
const JUPITER_PRICE_CACHE_TTL_MS = 5_000; // 5s cache for graduated token prices
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Fetch graduated token price from Jupiter Price API.
 * Returns price in lamports per raw token unit (6 decimals).
 * Cached for 5s to avoid hammering the API on every exit monitor poll.
 */
async function fetchGraduatedPriceLamports(mint: string): Promise<bigint | null> {
  const cached = graduatedPriceCache.get(mint);
  if (cached && nowMs() - cached.fetchedAt < JUPITER_PRICE_CACHE_TTL_MS) {
    return cached.priceLamports;
  }

  try {
    const url = `${JUPITER_PRICE_API}?ids=${mint}&vsToken=${SOL_MINT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json() as { data?: Record<string, { price?: number }> };
    const priceSol = data.data?.[mint]?.price;

    if (typeof priceSol !== 'number' || priceSol <= 0) return null;

    // Jupiter returns price as SOL per 1 token (human-readable).
    // 1 token = 10^6 raw units. We need lamports per raw unit.
    // priceLamports = priceSol * 10^9 / 10^6 = priceSol * 10^3
    const priceLamports = BigInt(Math.round(priceSol * 1_000));

    graduatedPriceCache.set(mint, { priceLamports, fetchedAt: nowMs() });
    logger.debug('Jupiter graduated price fetched', { mint, priceSol, priceLamports: priceLamports.toString() });
    return priceLamports;
  } catch (err: unknown) {
    logger.warn('Jupiter graduated price fetch failed', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
    return cached?.priceLamports ?? null;
  }
}

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
  detectors?: { bundleDetector?: { getLatestBundlePct(mint: string): number | null; forceAnalyze(mint: string): number }; washTradeDetector?: { getLatestWashScore(mint: string): number | null; forceAnalyze(mint: string): number } },
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
      // Parse bonding curve data ONCE and reuse for both price impact and market cap
      let parsedBC: { virtualSolReserves: bigint; virtualTokenReserves: bigint; realSolReserves: bigint; complete: boolean } | null = null;
      if (bondingCurveAccount?.data && bondingCurveAccount.data.length >= 49) {
        parsedBC = parseBondingCurveData(bondingCurveAccount.data);
      }

      let priceImpactBps: number | null = null;
      if (parsedBC && parsedBC.virtualSolReserves > 0n) {
        try {
          const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
          const positionSizeLamports = computePositionSizeLamports(solPriceUsd);
          // Use floating-point to avoid BigInt truncation to 0 for small positions
          priceImpactBps = Number(positionSizeLamports * 10000n) / Number(parsedBC.virtualSolReserves + positionSizeLamports);
        } catch (err: unknown) {
          logger.warn('Failed to compute price impact — SOL price unavailable', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
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

      // Calculate seconds since launch for late momentum detection
      const launchTimestamp = latestLaunch?.timestamp ?? null;
      const secondsSinceLaunch = launchTimestamp !== null
        ? Math.floor((nowMs() - launchTimestamp) / 1000)
        : null;

      // Calculate market cap from bonding curve data
      // Market cap = price * total supply
      // Price = virtualSolReserves / virtualTokenReserves (in SOL per token)
      // Market cap = price * supply in lamports
      let marketCapUsd: number | null = null;
      if (parsedBC && parsedBC.virtualTokenReserves > 0n && supply?.value) {
        try {
          const pricePerTokenLamports = parsedBC.virtualSolReserves * 10n ** 9n / parsedBC.virtualTokenReserves;
          const totalSupplyRaw = BigInt(supply.value.amount);
          const marketCapLamports = pricePerTokenLamports * totalSupplyRaw;
          const solPriceUsd = await container.solPriceOracle.getSolPriceUsd();
          // Divide in BigInt first to avoid Number overflow (marketCapLamports can exceed 2^53)
          marketCapUsd = Number(marketCapLamports / 10n ** 9n) * solPriceUsd;
        } catch (err: unknown) {
          logger.warn('Failed to calculate market cap', {
            mint: mint.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.debug('Entry check data fetched', {
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
        secondsSinceLaunch,
        marketCapUsd,
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
        bundlePct: detectors?.bundleDetector?.forceAnalyze(mint as any) ?? null,
        washTradeScore: detectors?.washTradeDetector?.forceAnalyze(mint) ?? null,
        uniqueWallets: 'uniqueWalletCount' in signal ? (signal as any).uniqueWalletCount as number : undefined,
        // Check 14: Sell pressure — now available from momentum signal
        sellCountInWindow: 'sellCount' in signal ? (signal as any).sellCount as number : undefined,
        // Check 15: Real SOL reserves in bonding curve
        realSolReservesLamports: parsedBC?.realSolReserves ?? null,
        // Check 16: Real holder count from Helius API (not just top 20)
        holderCount: await getRealHolderCount(mint, container.heliusApiKey).catch(() => largestAccounts?.value?.length ?? null),
        // Check 18: Real 1h volume in USD from DexScreener (not momentum window)
        volumeUsd: await getRealVolume1h(mint).catch(() => null)
          ?? await (async () => {
            try {
              const solPrice = await container.solPriceOracle.getSolPriceUsd();
              return Number(volumeLamports) / 1e9 * solPrice || undefined;
            } catch { return undefined; }
          })(),
        secondsSinceLaunch: secondsSinceLaunch ?? undefined,
        marketCapUsd,
      };
    },

    async getPositionData(tradeId: string): Promise<PositionData | null> {
      const pos = positionRegistry.get(tradeId);
      if (!pos) {
        // Clean up price trackers for exited positions to prevent memory leak
        highestPriceTracker.delete(tradeId);
        return null;
      }

      // Fetch current price from bonding curve (or Jupiter if graduated)
      const mintPk = new PublicKey(pos.mint);
      const bcPDA = deriveBondingCurvePDA(mintPk);

      // Track highest price for trailing stop (moved up — needed by fallback)
      const posTradeId = pos.tradeId ?? pos.id;
      const prevHighest = highestPriceTracker.get(posTradeId) ?? 0n;

      let currentPriceLamports = 0n;
      let graduated = false;
      

      // Fetch bonding curve account with error handling (RPC can fail)
      let bcAccount = null;
      let rpcFailed = false;
      try {
        bcAccount = await conn.getAccountInfo(bcPDA);
      } catch (rpcErr: unknown) {
        rpcFailed = true;
        logger.warn('RPC getAccountInfo failed — using prevHighest fallback', {
          mint: pos.mint,
          error: rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
        });
      }

      if (bcAccount?.data && bcAccount.data.length >= 49) {
        const parsed = parseBondingCurveData(bcAccount.data);
        if (parsed) {
          graduated = parsed.complete;
          if (!graduated && parsed.virtualTokenReserves > 0n) {
            currentPriceLamports = (parsed.virtualSolReserves * 10n ** 9n) / parsed.virtualTokenReserves;
          }
        } else {
          // Parse failed — bonding curve data is corrupt or format changed.
          // Use prevHighest to avoid false STOP_LOSS at -100%.
          if (prevHighest > 0n) {
            currentPriceLamports = prevHighest;
            logger.warn('Bonding curve parse failed — using prevHighest', {
              mint: pos.mint,
              dataLength: bcAccount.data.length,
              fallbackPrice: prevHighest.toString(),
            });
          }
        }
      } else if (!bcAccount) {
        if (rpcFailed) {
          // RPC failure (transient) — safe to use prevHighest
          if (prevHighest > 0n) {
            currentPriceLamports = prevHighest;
            logger.warn('Bonding curve RPC failed — using prevHighest', {
              mint: pos.mint,
              fallbackPrice: prevHighest.toString(),
            });
          }
        } else {
          // RPC succeeded but account is null → bonding curve deleted.
          // This is a strong rug pull signal. Do NOT use prevHighest —
          // let price stay at 0 so stop-loss triggers.
          logger.error('Bonding curve account GONE (rug pull?) — NOT using prevHighest fallback', {
            mint: pos.mint,
            prevHighest: prevHighest.toString(),
          });
        }
      }

      // Graduated: bonding curve drained → fetch real price from Jupiter/Raydium
      if (graduated) {
        const jupiterPrice = await fetchGraduatedPriceLamports(pos.mint);
        if (jupiterPrice !== null && jupiterPrice > 0n) {
          currentPriceLamports = jupiterPrice;
        } else if (prevHighest > 0n) {
          // Jupiter fetch failed — keep using last known good price so trailing
          // doesn't get a stale 0 and trigger false stop loss
          currentPriceLamports = prevHighest;
          logger.warn('Jupiter price unavailable for graduated token, using last known price', {
            mint: pos.mint,
            fallbackPrice: prevHighest.toString(),
          });
        }
      }

      // Safety: if currentPrice is STILL 0 but we have a previous highest,
      // use it. A real price crash to exactly 0 is extremely rare (rug pull
      // still has some residual value). Better to use stale price than trigger
      // a false -100% STOP_LOSS.
      if (currentPriceLamports === 0n && prevHighest > 0n) {
        currentPriceLamports = prevHighest;
        logger.warn('Price resolved to 0 but prevHighest exists — using fallback', {
          mint: pos.mint,
          fallbackPrice: prevHighest.toString(),
        });
      }

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

    isTokenBlacklisted(mint: string): boolean {
      return container.tokenBlacklist.isBlacklisted(mint);
    },
  };
}
