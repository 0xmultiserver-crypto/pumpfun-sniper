# Bug Tracker — Entry Checks Audit

Date: 2026-05-29
Auditor: Hermes Agent

## HIGH Priority

### BUG-001: Check 10 (price_impact) NULL → PASS
- **File**: src/strategies/filteredSniper/entryDecision.ts
- **Issue**: When SOL price oracle fails, priceImpactBps = null → check SKIPPED (PASS)
- **Impact**: Oracle outage bypasses price impact validation, high-impact buys slip through
- **Fix**: Change null handling from PASS to BLOCK
- **Status**: FIXED ✅

### BUG-002: Check 3 (creator_score) NULL → PASS
- **File**: src/strategies/filteredSniper/entryDecision.ts
- **Issue**: When creatorStatsRepository is DOWN, creatorScore = null → scoreOk = true (PASS)
- **Impact**: Bad creators with score < 45 can pass when stats repo is unreachable
- **Fix**: Change null handling from PASS to BLOCK (or default to score 0)
- **Status**: FIXED ✅

## MEDIUM Priority

### BUG-003: Checks 11+12 (bundle + wash_trade) forceAnalyze returns 0
- **File**: src/detectors/bundle/bundleDetector.ts, src/detectors/washTrade/washTradeDetector.ts
- **Issue**: forceAnalyze() returns 0 for tokens with no tracking data, not null
- **Impact**: Tokens with insufficient data treated as "clean" (no bundles, no wash)
- **Fix**: forceAnalyze should return null when data is insufficient
- **Status**: FIXED ✅

### BUG-004: SOL price oracle single point of failure (checks 10+17+18)
- **File**: src/app/solPriceOracle.ts, src/app/dataProvider.ts
- **Issue**: Oracle outage simultaneously disables 3 safety checks
- **Impact**: Multiple checks bypassed during oracle outage
- **Fix**: Use cached/stale SOL price, or BLOCK when price unavailable
- **Status**: FIXED ✅ — cached SOL price + DexScreener fallback

### BUG-011: Graduated token price stuck when Jupiter returns null
- **File**: src/app/dataProvider.ts fetchGraduatedPriceLamports()
- **Issue**: When Jupiter returns null for graduated token, bot uses stale prevHighest price forever
- **Impact**: Position stuck, bot spam Jupiter API every 1-2s, SL never triggers
- **Root cause: FmLJUTt77BXJjaMoHwqRmxsL58ayHK37MvpJ3JZJpump — graduated, Jupiter null, 9.2B tokens orphaned
- **Fix**: Added DexScreener fallback when Jupiter returns null
- **Status**: FIXED ✅

### BUG-005: Check 8 (wallet_concentration) 75% too permissive
- **File**: src/core/constants/defaults/detection.ts
- **Issue**: A single wallet can hold 74% of non-BC supply and still pass
- **Impact**: Dangerous concentration levels can pass
- **Fix**: Consider lowering to 50-60%, or add holder count minimum
- **Status**: FIXED ✅

### BUG-012: Reconciler overwrites sell executor's record (race condition)
- **File**: src/app/positionReconciler.ts
- **Issue**: Reconciler creates SELL with null signature/0 amount, overwrites sell executor's real record via UPSERT
- **Impact**: Bot sells token at profit, but DB records $0 — PnL tracking broken
- **Root cause: 4dEJqKcj — bot sold +150% but DB shows $0 because reconciler overwrote
- **Fix**: Check if sell executor already saved record before reconciling
- **Status**: FIXED ✅

### BUG-013: entryPriceSol BigInt truncation (CRITICAL)
- **File**: src/app/execution/buyExecutor.ts
- **Issue**: `actualAmountSol / entryTokens` truncates to 0 for BigInt division
- **Impact**: Entry price = 0 → PnL always -100% → STOP_LOSS triggers on ALL tokens
- **Fix**: `actualAmountSol * 10n**9n / entryTokens` (matches bonding curve price formula)
- **Status**: FIXED ✅

## LOW Priority

### BUG-006: Check 13 error message says "min 8" but threshold is 12
- **File**: src/strategies/filteredSniper/entryDecision.ts
- **Status**: ALREADY FIXED (earlier session)

### BUG-007: Check 8 variable bcATAStr misnamed (should be bcPDAStr)
- **File**: src/app/dataProvider.ts
- **Status**: FIXED ✅

### BUG-008: Check 6 metadata regex false positives ("rug", "fake")
- **File**: src/app/entryCheckEvaluator.ts
- **Status**: FIXED ✅

### BUG-009: Check 7 liquidity_sane 0.1 SOL redundant with check 15 (0.5 SOL)
- **File**: src/strategies/filteredSniper/entryDecision.ts
- **Status**: FIXED ✅

### BUG-010: Null handling inconsistency across checks
- **Status**: FIXED ✅ — documented null handling rationale
