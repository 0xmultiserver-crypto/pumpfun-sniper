# PumpFun Bot — Implementation Roadmap

Generated from full pipeline audit (2026-05-27).
Excludes: Telegram/Discord notifications (not needed).

## Status Legend
- [ ] TODO
- [~] IN PROGRESS
- [x] DONE

---

## PHASE 1 — Quick Fixes (current session)

### 1.1 Fix 7 Failing Tests
- [ ] `computeBudget.test.ts` — update expectations to 150000n (not 50000n)
- [ ] `cooldownManager.test.ts` — update to 120s cooldown (not 300s)
- [ ] `entryExitDecision.test.ts` — fix trailing stop tests to match new constants

### 1.2 Fix Constants Comment Mismatches (`defaults.ts`)
- [ ] Line 17: comment says "$20" → fix to "$1"
- [ ] Line 21: comment says "+50%" → fix to "+500%"
- [ ] Line 33: comment says "10 minutes (600 seconds)" → fix to "60 minutes (3600 seconds)"
- [ ] Line 36: comment says "2" → fix to "1"
- [ ] Audit ALL comments vs values in defaults.ts

---

## PHASE 2 — Risk Persistence

### 2.1 Persist Risk State to DB
- [ ] Add `risk_state` table (key-value with JSONB)
- [ ] Persist DailyLossGuard daily PnL + trade count + stop loss count
- [ ] Persist CreatorBlacklist entries
- [ ] Persist CooldownManager expiry timestamp
- [ ] On startup: restore all risk state from DB
- [ ] On state change: write-through to DB

---

## PHASE 3 — Strategy Enhancements

### 3.1 Price Impact Check Before Buy
- [ ] Calculate price impact from bonding curve reserves
- [ ] Reject buys where price impact > threshold (configurable, default 5%)
- [ ] Add as 10th entry check

### 3.2 Creator Scoring System
- [ ] Track creator stats: total launches, avg survival time, rug rate
- [ ] Score 0-100 per creator wallet
- [ ] Integrate as weight in entry decision
- [ ] Persist scores to DB
- [ ] Auto-blacklist creators with score < 20

### 3.3 Dynamic Position Sizing
- [ ] Scale position size based on signal strength
- [ ] Factors: momentum volume ratio, creator score, time since launch
- [ ] Min $0.50, Max $5 (configurable)
- [ ] Respect total exposure cap

### 3.4 Smart Exit — Scale Out
- [ ] Sell 50% at +100% profit
- [ ] Sell 25% at +300% profit
- [ ] Let 25% ride with trailing stop
- [ ] Configurable percentages and thresholds

### 3.5 Anti-Rug Mechanism
- [ ] Monitor top holder wallets for large transfers
- [ ] Emergency exit if top holder dumps > 10% supply
- [ ] Real-time holder concentration tracking during position

---

## PHASE 4 — Execution Improvements

### 4.1 MEV Protection (Jito Bundles)
- [ ] Add Jito block engine client
- [ ] Submit buy/sell TXs as Jito bundles
- [ ] Configurable tip amount (default 10k lamports)
- [ ] Fallback to normal submission if Jito fails

### 4.2 Dynamic Compute Unit Estimation
- [ ] Estimate CU per TX type (buy/sell) from historical data
- [ ] Replace fixed CU limit with estimated + buffer
- [ ] Track actual CU used per TX for calibration

---

## PHASE 5 — Infrastructure

### 5.1 Metrics (Prometheus)
- [ ] Add prom-client dependency
- [ ] Expose /metrics HTTP endpoint
- [ ] Track: events/sec, signals, buys, sells, PnL, win rate, bundle detection
- [ ] Grafana dashboard JSON template

### 5.2 Multi-Wallet Support
- [ ] Support N wallets (configurable)
- [ ] Distribute buys round-robin or by wallet balance
- [ ] Per-wallet exposure tracking
- [ ] Independent risk guards per wallet

### 5.3 Backtest Engine
- [ ] Record all WS events to file/DB
- [ ] Replay events through strategy with parameter overrides
- [ ] Output: PnL curve, win rate, max drawdown, Sharpe ratio
- [ ] CLI command: `npm run backtest -- --from=2026-05-01 --to=2026-05-27`

---

## Execution Order
1. Phase 1 (quick fixes) — 15 min
2. Phase 2 (risk persistence) — 2-3 hours
3. Phase 3.1 (price impact) — 1 hour
4. Phase 3.2 (creator scoring) — 2 hours
5. Phase 3.3 (dynamic sizing) — 1 hour
6. Phase 3.4 (scale out) — 2 hours
7. Phase 3.5 (anti-rug) — 2 hours
8. Phase 4.1 (Jito) — 2 hours
9. Phase 4.2 (CU estimation) — 1 hour
10. Phase 5.1 (Prometheus) — 1 hour
11. Phase 5.2 (multi-wallet) — 3 hours
12. Phase 5.3 (backtest) — 3 hours
