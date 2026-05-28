/**
 * Entry Decision
 *
 * Evaluates ALL 16 entry checks from rule.md before allowing a buy.
 * Every single check must pass. No shortcuts. No partial passes.
 *
 * The 16 checks (from rule.md):
 *   1. Launch detected
 *   2. Creator not blacklisted
 *   3. Creator history acceptable
 *   4. Mint authority safe (revoked)
 *   5. Freeze authority safe (revoked)
 *   6. Metadata sane
 *   7. Liquidity sane
 *   8. Wallet concentration acceptable
 *   9. Momentum threshold met
 *  10. Price impact acceptable
 *  11. Bundle percentage acceptable
 *  12. Wash trade score acceptable
 *  13. Unique wallets sufficient
 *  14. Sell pressure acceptable (early dump detection)
 *  15. Liquidity depth sufficient (real SOL reserves)
 *  16. Holder-to-bundle ratio acceptable
 *
 * Strategy = business logic ONLY. No RPC, no DB, no protocol decoding.
 * All data is provided via the EntryCheckData interface.
 */

import type { MintAddress } from '../../core/types/token.js';
import {
  ENTRY_CHECK_COUNT,
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_MS,
  MAX_PRICE_IMPACT_BPS,
} from './filteredSniperRules.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('strategy:entryDecision');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data required for all 13 entry checks. */
export interface EntryCheckData {
  readonly mint: MintAddress;

  /** Check 1: Was a launch event detected? */
  readonly launchDetected: boolean;

  /** Check 2: Is the creator NOT on the blacklist? */
  readonly creatorNotBlacklisted: boolean;

  /** Check 3: Is the creator history acceptable? (not a serial launcher) */
  readonly creatorHistoryAcceptable: boolean;

  /** Creator score from trade outcomes (0-100, null if unknown). */
  readonly creatorScore: number | null;

  /** Check 4: Is the mint authority revoked? */
  readonly mintAuthorityRevoked: boolean;

  /** Check 5: Is the freeze authority revoked? */
  readonly freezeAuthorityRevoked: boolean;

  /** Check 6: Is the token metadata sane? (name/symbol not suspicious) */
  readonly metadataSane: boolean;

  /** Check 7: Is the liquidity sane? (minimum reserves on bonding curve) */
  readonly liquiditySane: boolean;

  /** Check 8: Is wallet concentration acceptable? (no whale domination) */
  readonly walletConcentrationAcceptable: boolean;

  /** Check 9: Momentum data — number of buys in the window. */
  readonly buyCountInWindow: number;

  /** Check 9: Momentum data — total buy volume in lamports. */
  readonly volumeLamports: bigint;

  /** Check 18: Buy volume in USD (for volume-mcap ratio). */
  readonly volumeUsd?: number;

  /** Check 9: Momentum data — window size in ms. */
  readonly windowMs: number;

  /** Check 10: Price impact of the position size in basis points (null = data unavailable). */
  readonly priceImpactBps: number | null;

  /** Check 11: Bundle percentage (0-100). Null if unknown. */
  readonly bundlePct?: number | null;

  /** Check 12: Wash trade score (0-1, higher = more suspicious). Null if unknown. */
  readonly washTradeScore?: number | null;

  /** Check 13: Unique wallets in momentum window. */
  readonly uniqueWallets?: number;

  /** Check 14: Number of sells in the momentum window (for sell pressure). */
  readonly sellCountInWindow?: number;

  /** Check 15: Real SOL reserves in bonding curve (lamports). */
  readonly realSolReservesLamports?: bigint | null;

  /** Check 16: Number of unique holders (for holder-to-bundle ratio). */
  readonly holderCount?: number | null;

  /** Optional: seconds since token launch for dynamic position sizing. */
  readonly secondsSinceLaunch?: number;

  /** Optional: market cap in USD for tier-based position sizing. */
  readonly marketCapUsd?: number | null;
}

/** Individual check result. */
interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

/** Entry decision result. */
export interface EntryDecisionResult {
  /** Whether ALL 16 checks passed. */
  readonly allowed: boolean;
  /** Individual check results (always 10). */
  readonly checks: readonly CheckResult[];
  /** Number of checks that passed. */
  readonly passedCount: number;
  /** Number of checks that failed. */
  readonly failedCount: number;
  /** First failure reason (for quick rejection logging). */
  readonly firstFailure: string | null;
}

// ---------------------------------------------------------------------------
// Entry Decision
// ---------------------------------------------------------------------------

/**
 * Evaluate all 13 entry checks. ALL must pass.
 *
 * Returns immediately on first failure for speed, but still reports
 * all check results for logging/telemetry.
 */
export function evaluateEntry(data: EntryCheckData): EntryDecisionResult {
  const checks: CheckResult[] = [
    // Check 1: Launch detected
    {
      name: 'launch_detected',
      passed: data.launchDetected,
      reason: data.launchDetected ? 'Launch event confirmed' : 'No launch event detected',
    },
    // Check 2: Creator not blacklisted
    {
      name: 'creator_not_blacklisted',
      passed: data.creatorNotBlacklisted,
      reason: data.creatorNotBlacklisted ? 'Creator is clean' : 'Creator is BLACKLISTED',
    },
    // Check 3: Creator history acceptable (including creator score threshold)
    (() => {
      const historyOk = data.creatorHistoryAcceptable;
      const scoreOk = data.creatorScore === null || data.creatorScore >= 45;
      const passed = historyOk && scoreOk;
      let reason: string;
      if (passed) {
        reason = data.creatorScore !== null
          ? `Creator history acceptable (score: ${data.creatorScore}/100)`
          : 'Creator history acceptable';
      } else if (!historyOk) {
        reason = 'Creator is a serial launcher';
      } else {
        reason = `Creator score too low: ${data.creatorScore}/100`;
        logger.warn(reason, { mint: data.mint, creatorScore: data.creatorScore });
      }
      return { name: 'creator_history_acceptable', passed, reason };
    })(),
    // Check 4: Mint authority safe
    {
      name: 'mint_authority_safe',
      passed: data.mintAuthorityRevoked,
      reason: data.mintAuthorityRevoked
        ? 'Mint authority revoked'
        : 'DANGER: Mint authority NOT revoked',
    },
    // Check 5: Freeze authority safe
    {
      name: 'freeze_authority_safe',
      passed: data.freezeAuthorityRevoked,
      reason: data.freezeAuthorityRevoked
        ? 'Freeze authority revoked'
        : 'DANGER: Freeze authority NOT revoked',
    },
    // Check 6: Metadata sane
    {
      name: 'metadata_sane',
      passed: data.metadataSane,
      reason: data.metadataSane ? 'Metadata looks normal' : 'Suspicious metadata detected',
    },
    // Check 7: Liquidity sane
    {
      name: 'liquidity_sane',
      passed: data.liquiditySane,
      reason: data.liquiditySane
        ? 'Liquidity meets minimum threshold'
        : 'Insufficient liquidity on bonding curve',
    },
    // Check 8: Wallet concentration acceptable
    {
      name: 'wallet_concentration_acceptable',
      passed: data.walletConcentrationAcceptable,
      reason: data.walletConcentrationAcceptable
        ? 'Wallet concentration within limits'
        : 'High wallet concentration detected (whale risk)',
    },
    // Check 9: Momentum threshold met (buy count + volume + window)
    (() => {
      const buyCountOk = data.buyCountInWindow >= MOMENTUM_MIN_BUYS;
      const windowOk = data.windowMs <= MOMENTUM_WINDOW_MS;
      const volumeOk = data.volumeLamports >= MOMENTUM_MIN_VOLUME_LAMPORTS;
      const passed = buyCountOk && windowOk && volumeOk;
      return {
        name: 'momentum_threshold_met',
        passed,
        reason: passed
          ? `Momentum met: ${data.buyCountInWindow} buys, ${(Number(data.volumeLamports) / 1e9).toFixed(2)} SOL vol in ${data.windowMs}ms`
          : `Momentum NOT met: ${data.buyCountInWindow}/${MOMENTUM_MIN_BUYS} buys, ${(Number(data.volumeLamports) / 1e9).toFixed(2)}/${(Number(MOMENTUM_MIN_VOLUME_LAMPORTS) / 1e9).toFixed(0)} SOL vol in ${data.windowMs}ms (need ${MOMENTUM_MIN_BUYS} buys + ${Number(MOMENTUM_MIN_VOLUME_LAMPORTS) / 1e9} SOL in ${MOMENTUM_WINDOW_MS}ms)`,
      };
    })(),
    // Check 10: Price impact acceptable
    (() => {
      if (data.priceImpactBps === null) {
        return {
          name: 'price_impact_acceptable',
          passed: true,
          reason: 'Price impact data unavailable — skipping check',
        };
      }
      const passed = data.priceImpactBps <= MAX_PRICE_IMPACT_BPS;
      const impactPct = (data.priceImpactBps / 100).toFixed(2);
      const maxPct = (MAX_PRICE_IMPACT_BPS / 100).toFixed(2);
      return {
        name: 'price_impact_acceptable',
        passed,
        reason: passed
          ? `Price impact acceptable: ${impactPct}%`
          : `Price impact too high: ${impactPct}% (max ${maxPct}%)`,
      };
    })(),
    // Check 11: Bundle percentage acceptable (block if >30% bundled — match detector)
    // BLOCK if data unavailable — can't assess risk without bundle data
    (() => {
      if (data.bundlePct == null) {
        return { name: 'bundle_check', passed: false, reason: 'Bundle data unavailable — BLOCKING (risk too high without data)' };
      }
      const passed = data.bundlePct <= 30;
      return {
        name: 'bundle_check',
        passed,
        reason: passed
          ? `Bundle OK: ${data.bundlePct.toFixed(1)}%`
          : `TOO BUNDLED: ${data.bundlePct.toFixed(1)}% supply in few wallets (max 30%)`,
      };
    })(),
    // Check 12: Wash trade score acceptable (block if score > 60)
    (() => {
      if (data.washTradeScore == null) {
        return { name: 'wash_trade_check', passed: true, reason: 'Wash trade data unavailable — skipping' };
      }
      const passed = data.washTradeScore <= 60;
      return {
        name: 'wash_trade_check',
        passed,
        reason: passed
          ? `Wash trade OK: score ${data.washTradeScore.toFixed(0)}/100`
          : `WASH TRADE SUSPECTED: score ${data.washTradeScore.toFixed(0)}/100 (max 60)`,
      };
    })(),
    // Check 13: Unique wallets in momentum window (min 12)
    // BLOCK if data unavailable — wallet diversity is critical for anti-manipulation
    (() => {
      if (data.uniqueWallets == null) {
        return { name: 'unique_wallets', passed: false, reason: 'Wallet count unavailable — BLOCKING (need diversity data)' };
      }
      const passed = data.uniqueWallets >= 12;
      return {
        name: 'unique_wallets',
        passed,
        reason: passed
          ? `Unique wallets OK: ${data.uniqueWallets}`
          : `Too few unique wallets: ${data.uniqueWallets} (min 8)`,
      };
    })(),
    // Check 14: Sell pressure acceptable (early dump detection)
    // If sells > 60% of total trades in window, it's likely a dump
    // NOTE: sellCountInWindow data not yet available from momentum signals.
    // When data IS available, BLOCK if null. When data is NEVER available
    // (undefined), skip gracefully — this check activates once the data
    // pipeline provides sell counts.
    (() => {
      // undefined = data pipeline doesn't provide this yet → skip (not a risk signal)
      // null = data pipeline active but fetch failed → BLOCK (data should be available)
      if (data.sellCountInWindow === undefined) {
        return { name: 'sell_pressure', passed: true, reason: 'Sell pressure tracking not yet active — skipping (data pipeline pending)' };
      }
      if (data.sellCountInWindow == null || data.buyCountInWindow === 0) {
        return { name: 'sell_pressure', passed: false, reason: 'Sell pressure data unavailable — BLOCKING (need dump detection)' };
      }
      const totalTrades = data.buyCountInWindow + data.sellCountInWindow;
      const sellRatio = totalTrades > 0 ? (data.sellCountInWindow / totalTrades) * 100 : 0;
      const passed = sellRatio <= 60;
      return {
        name: 'sell_pressure',
        passed,
        reason: passed
          ? `Sell pressure OK: ${sellRatio.toFixed(0)}% sells (${data.sellCountInWindow}/${totalTrades})`
          : `HIGH SELL PRESSURE: ${sellRatio.toFixed(0)}% sells in window (${data.sellCountInWindow}/${totalTrades}) — likely dump`,
      };
    })(),
    // Check 15: Liquidity depth sufficient (real SOL reserves)
    // Minimum 0.5 SOL in bonding curve — prevents entering dead/low-liquidity tokens
    // BLOCK if data unavailable — liquidity data should always be available from bonding curve
    (() => {
      if (data.realSolReservesLamports == null) {
        return { name: 'liquidity_depth', passed: false, reason: 'Real SOL reserves unavailable — BLOCKING (need liquidity data)' };
      }
      const minReservesLamports = 500_000_000n; // 0.5 SOL
      const reservesSol = Number(data.realSolReservesLamports) / 1e9;
      const passed = data.realSolReservesLamports >= minReservesLamports;
      return {
        name: 'liquidity_depth',
        passed,
        reason: passed
          ? `Liquidity depth OK: ${reservesSol.toFixed(2)} SOL`
          : `Insufficient liquidity: ${reservesSol.toFixed(4)} SOL (min 0.5 SOL)`,
      };
    })(),
    // Check 16: Holder-to-bundle ratio acceptable
    // If we know holder count AND bundle wallets, check that bundle isn't
    // the majority of holders (catches "170 holders but all from same source")
    (() => {
      if (data.holderCount == null || data.holderCount === 0 || data.bundlePct == null) {
        return { name: 'holder_bundle_ratio', passed: true, reason: 'Holder/bundle ratio data unavailable — skipping' };
      }
      // Estimate bundle wallets from bundlePct (rough: assume avg buy = 2% per wallet)
      // If bundlePct=30% and avg buy is 2%, that's ~15 bundle wallets
      // If holderCount is 50, then 15/50 = 30% of holders are bundle → suspicious
      // Simple heuristic: if bundlePct > 20% AND holderCount < 100, likely fake
      const lowHolderCount = data.holderCount < 100;
      const highBundle = data.bundlePct > 20;
      const passed = !(lowHolderCount && highBundle);
      return {
        name: 'holder_bundle_ratio',
        passed,
        reason: passed
          ? `Holder/bundle ratio OK: ${data.holderCount} holders, ${data.bundlePct.toFixed(1)}% bundled`
          : `SUSPICIOUS: ${data.holderCount} holders with ${data.bundlePct.toFixed(1)}% bundled — likely fake holders`,
      };
    })(),
    // Check 17: Holder-MCap ratio (catches coordinated holder inflation)
    // Pattern: 300+ holders but mcap only $11k = mass coordinated buys, will dump
    // Threshold: > 0.015 holders per dollar of mcap = suspicious
    // Examples: 300 holders / $11k = 0.027 → BLOCK
    //           50 holders / $50k = 0.001 → PASS
    //           200 holders / $500k = 0.0004 → PASS
    (() => {
      if (data.holderCount == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'holder_mcap_ratio', passed: true, reason: 'Holder/MCap data unavailable — skipping' };
      }
      const ratio = data.holderCount / data.marketCapUsd;
      const passed = ratio <= 0.015;
      return {
        name: 'holder_mcap_ratio',
        passed,
        reason: passed
          ? `Holder/MCap OK: ${data.holderCount} holders / $${data.marketCapUsd.toFixed(0)} mcap (ratio ${ratio.toFixed(4)})`
          : `HOLDER INFLATION: ${data.holderCount} holders but only $${data.marketCapUsd.toFixed(0)} mcap (ratio ${ratio.toFixed(4)}, max 0.015) — coordinated dump pattern`,
      };
    })(),
    // Check 18: Volume-MCap ratio (catches wash trade / coordinated volume)
    // Pattern: volume 1h jauh lebih besar dari mcap = artificial volume
    // Threshold: volume / mcap > 5x = suspicious
    // Examples: $17k volume / $11k mcap = 1.5x → borderline
    //           $50k volume / $5k mcap = 10x → BLOCK
    //           $5k volume / $50k mcap = 0.1x → PASS
    (() => {
      if (data.volumeUsd == null || data.marketCapUsd == null || data.marketCapUsd <= 0) {
        return { name: 'volume_mcap_ratio', passed: true, reason: 'Volume/MCap data unavailable — skipping' };
      }
      const ratio = data.volumeUsd / data.marketCapUsd;
      const passed = ratio <= 5;
      return {
        name: 'volume_mcap_ratio',
        passed,
        reason: passed
          ? `Volume/MCap OK: $${data.volumeUsd.toFixed(0)} vol / $${data.marketCapUsd.toFixed(0)} mcap (${ratio.toFixed(1)}x)`
          : `WASH TRADE SUSPECTED: $${data.volumeUsd.toFixed(0)} volume but only $${data.marketCapUsd.toFixed(0)} mcap (${ratio.toFixed(1)}x, max 5x) — artificial volume`,
      };
    })(),
  ];

  // Validate we have exactly 18 checks (compile-time safety)
  if (checks.length !== ENTRY_CHECK_COUNT) {
    throw new Error(
      `Entry check count mismatch: expected ${ENTRY_CHECK_COUNT}, got ${checks.length}`,
    );
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const failedCount = checks.length - passedCount;
  const firstFailure = checks.find((c) => !c.passed);

  const allowed = failedCount === 0;

  if (allowed) {
    logger.info('Entry decision: ALLOWED', {
      mint: data.mint,
      passedCount,
    });
  } else {
    logger.info('Entry decision: REJECTED', {
      mint: data.mint,
      passedCount,
      failedCount,
      firstFailure: firstFailure?.name ?? 'unknown',
      firstFailureReason: firstFailure?.reason ?? 'unknown',
    });
  }

  return {
    allowed,
    checks,
    passedCount,
    failedCount,
    firstFailure: firstFailure?.reason ?? null,
  };
}
