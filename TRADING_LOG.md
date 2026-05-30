# Trading Log — Filter Validation

Started: 2026-05-29 16:08 UTC+8
Position: $0.20 | Max 2 | SL -60% | TP +1500%
Filters: 19 checks (with smart money boost)

## Trades

| # | Time | Mint | Entry | Exit | PnL% | Hold | Exit Reason | Notes |
|---|------|------|-------|------|------|------|-------------|-------|
| 1 | 00:08 | Gn99Y7t8 | $0.20 | $0.05 | -75% | 1.5m | STOP_LOSS | Price crashed fast, slippage |
| 2 | 00:41 | 7zd4hBVr | $0.20 | $0.08 | -60% | 2.7m | STOP_LOSS | Clean SL trigger |

## Filter Rejection Breakdown (cumulative, 20 min)

| Check | Rejections | % |
|-------|-----------|---|
| wallet_concentration | 22 | 76% |
| bundle_check | 4 | 14% |
| unique_wallets | 3 | 10% |

## Tokens Evaluated: ~42
## Tokens Passed All 19 Checks: 1 (2.4%)
## Win Rate: 0/2 (0%) — both STOP_LOSS

## Observations
- Wallet concentration check was rejecting 76% of tokens
- ROOT CAUSE BUG FOUND: bonding curve ATA was included in top holder count
- Bonding curve holds unsold supply — NOT a real whale
- Fixed: now filters out bonding curve ATA before concentration check
- This should significantly increase pass rate for PumpFun tokens

## Fixes Applied During Monitoring
- 2026-05-29 00:36: Filter bonding curve ATA from wallet concentration check

## Next Steps
- Continue monitoring for more data points
- Track which tokens that PASSED would have been profitable
- Track which tokens that FAILED would have been profitable (missed opportunities)
- Evaluate if wallet concentration threshold (60%) is too tight
