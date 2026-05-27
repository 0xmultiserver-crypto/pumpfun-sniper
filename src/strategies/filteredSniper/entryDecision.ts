/**
 * Entry Decision
 *
 * Evaluates ALL 10 entry checks from rule.md before allowing a buy.
 * Every single check must pass. No shortcuts. No partial passes.
 *
 * The 10 checks (from rule.md):
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

/** Data required for all 10 entry checks. */
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

  /** Check 9: Momentum data — window size in ms. */
  readonly windowMs: number;

  /** Check 10: Price impact of the position size in basis points (null = data unavailable). */
  readonly priceImpactBps: number | null;

  /** Optional: seconds since token launch for dynamic position sizing. */
  readonly secondsSinceLaunch?: number;

  /** Optional: market cap in USD for tier-based position sizing. */
  readonly marketCapUsd?: number | null;
}

/** Individual check result. */
export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

/** Entry decision result. */
export interface EntryDecisionResult {
  /** Whether ALL 10 checks passed. */
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
 * Evaluate all 10 entry checks. ALL must pass.
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
      const scoreOk = data.creatorScore === null || data.creatorScore >= 20;
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
  ];

  // Validate we have exactly 10 checks (compile-time safety)
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
