# PumpFun Bot — Implementation Roadmap

Generated from ponyin.id trading intel + bot audit (2026-05-27).

## Status Legend
- [ ] TODO
- [~] IN PROGRESS
- [x] DONE

---

## PHASE 1 — Quick Wins (current session)

### 1.1 Fix Signal Error Handling
- [x] Replace `void strategy.onSignal()` with `.catch()` + logger.error
- [x] Add debug log at onSignal entry (mint, signalType, state)
- [x] Build + restart bot

### 1.2 Fix 7 Failing Tests
- [ ] `computeBudget.test.ts` — update expectations to 150000n (not 50000n)
- [ ] `cooldownManager.test.ts` — update to 120s cooldown (not 300s)
- [ ] `entryExitDecision.test.ts` — fix trailing stop tests to match new constants

### 1.3 Fix Constants Comment Mismatches (`defaults.ts`)
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

## PHASE 3 — Ponyin Intel: Entry Filters

### 3.1 Bundle Detection (from ponyin.id #1)
**Concept:** Dev splits supply ke puluhan wallet, beli di milidetik pertama launch.
Dari luar terlihat organik, padahal 1 komando.
- [ ] Cluster wallet berdasarkan: same block purchase, same funding source
- [ ] Calculate bundlePct = % supply yang dibeli dalam window pertama oleh wallet cluster
- [ ] Entry check baru: bundlePct > 30% = REJECT (configurable)
- [ ] Log: "Bundle detected: X wallets bought Y% supply in Zms"

### 3.2 Global Fee / Wash Trade Detector (from ponyin.id #2)
**Concept:** Volume palsu = volume tinggi tapi fee sangat kecil.
Fee sebanding dengan volume = organic. Fee kecil + volume besar = wash trade.
- [ ] Detector baru: `washTradeDetector`
- [ ] Metric: feeVolumeRatio = totalFee / totalVolume
- [ ] Kalau ratio < threshold (e.g. 0.1%) = suspicious volume
- [ ] Entry check: washTradeScore > threshold = REJECT
- [ ] Data source: DexScreener API atau on-chain fee calculation

### 3.3 Dex Paid / Ads / Boost Timing (from ponyin.id #5)
**Concept:** Dex Paid positif kalau di awal launch. Muncul SETELAH pump besar = FOMO trap.
- [ ] Track dexPaidTimestamp vs token launch timestamp
- [ ] Kalau gap > 30 menit = "late dex paid" = suspicious
- [ ] Entry check: lateDexPaid = REJECT atau reduce confidence
- [ ] Data source: DexScreener API (dexPaid field)

### 3.4 Revoke Timing Analysis (from ponyin.id #3)
**Concept:** Revoke sudah dilakukan ≠ token aman.
Revoke SETELAH dev dump = jebakan. Revoke SEBELUM launch = positive signal.
- [ ] Track revokeTimestamp vs launchTimestamp vs firstDumpTimestamp
- [ ] Kalau revoke setelah ada large sell = suspicious
- [ ] Enhance existing check #4 (mint authority) dengan timing analysis

### 3.5 Market Cap Tier Strategy (from ponyin.id #9)
**Concept:** Beda market cap = beda lawan, beda strategi.
- [ ] Micro (<$100K): snipe only, position size kecil
- [ ] Small ($100K-$1M): momentum play, position size medium
- [ ] Mid ($1M-$10M): swing trade, position size besar
- [ ] Dynamic position sizing by market cap tier
- [ ] Dynamic TP/SL by market cap tier

---

## PHASE 4 — Ponyin Intel: Detectors

### 4.1 Smart Money / Wallet Ping Detector (from ponyin.id A3)
**Concept:** Track wallet yang sering masuk awal di token runner.
10 mata lebih baik dari 2 mata.
- [ ] Build "smart wallet" database dari historical winners
- [ ] Track wallets yang masuk di top 20 trader per token runner
- [ ] Detector baru: `smartMoneyDetector`
- [ ] Kalau smart wallet beli token baru → momentum signal boost
- [ ] Auto-discover: dari wallet yang profitable, trace wallet lain yang sering berinteraksi

### 4.2 Cabal Wallet Cluster Detection (from ponyin.id #7)
**Concept:** Cabal = kelompok tertutup yang rencanakan launch terkoordinasi.
3 tipe: Group Cabal, Solo Cabal, Conflict Cabal.
- [ ] Track wallet yang sering muncul bareng di token yang sama
- [ ] Build "cabal score" per wallet cluster
- [ ] Detector baru: `cabalDetector`
- [ ] Kalau 3+ wallet dari cluster sama beli bersamaan = cabal play
- [ ] Extend creator blacklist → cabal cluster blacklist

### 4.3 Holder Concentration Enhancement (from ponyin.id #8)
**Concept:** Rule "holder < 5%" sudah outdated di era multi-wallet.
1 orang bisa pegang 20% lewat 10 wallet masing-masing 2%.
- [ ] Enhance check #8 (wallet concentration) dengan wallet clustering
- [ ] Cluster by funding source (wallet yang di-fund dari sumber sama)
- [ ] Calculate "effective concentration" = clustered %, bukan individual %
- [ ] Kalau effective concentration > 40% = REJECT

---

## PHASE 5 — Ponyin Intel: Exit Strategy

### 5.1 3 Candle Confirmation Exit (from ponyin.id #6)
**Concept:** Jangan exit di candle merah pertama. Tunggu konfirmasi.
- [ ] Track candle pattern (OHLC dari bonding curve price)
- [ ] Kalau candle merah pertama + volume turun = watch, jangan panic sell
- [ ] Kalau 3 candle merah berturut + volume naik = exit signal
- [ ] Enhance exitDecision.ts dengan candle pattern analysis

### 5.2 Day Phase Trade Strategy (from ponyin.id #✦)
**Concept:** Entry di fase cooldown → sideways. Bukan parabolic.
Cari token trending 1-2 minggu lalu, dip 50-70% dari ATH.
- [ ] Detector baru: `dayPhaseDetector`
- [ ] Criteria: FDV > $1M, dip 50-70% dari ATH, sideways 3-5 hari
- [ ] Community masih aktif (Twitter/TG engagement)
- [ ] Holder count stabil atau naik tipis
- [ ] Exit target: 2-3x dari entry (bukan 10x)

### 5.3 Compounding Profit Strategy (from ponyin.id A4)
**Concept:** 35% take profit dipindah ke wallet terpisah.
Sisanya compound ke trade berikutnya.
- [ ] On take profit: 35% → cold wallet, 65% → trading wallet
- [ ] Track compounding balance per wallet
- [ ] Target 50% per trade dari 80% modal
- [ ] Integrate dengan scale-out exit logic

---

## PHASE 6 — Execution Improvements

### 6.1 Rent Refund (from ponyin.id A6)
**Concept:** Setiap buy di Solana ada rent (~0.002 SOL per account).
Bisa di-reclaim setelah sell.
- [ ] Post-sell: close token accounts dan reclaim rent
- [ ] Batch rent reclaim (tutup banyak account sekaligus)
- [ ] Track total rent recovered per session

### 6.2 Multi-Wallet Buy Distribution (from ponyin.id A8)
**Concept:** Spread buy ke beberapa wallet supaya terlihat organik.
Bisa trigger bot lain untuk ikut beli.
- [ ] Support N wallets (configurable)
- [ ] Distribute buys round-robin atau by wallet balance
- [ ] Per-wallet exposure tracking
- [ ] Independent risk guards per wallet

### 6.3 MEV Protection (Jito Bundles)
- [ ] Add Jito block engine client
- [ ] Submit buy/sell TXs as Jito bundles
- [ ] Configurable tip amount (default 10k lamports)
- [ ] Fallback to normal submission if Jito fails

### 6.4 Dynamic Compute Unit Estimation
- [ ] Estimate CU per TX type (buy/sell) from historical data
- [ ] Replace fixed CU limit with estimated + buffer
- [ ] Track actual CU used per TX for calibration

---

## PHASE 7 — Infrastructure

### 7.1 Metrics (Prometheus)
- [ ] Add prom-client dependency
- [ ] Expose /metrics HTTP endpoint
- [ ] Track: events/sec, signals, buys, sells, PnL, win rate, bundle detection
- [ ] Grafana dashboard JSON template

### 7.2 Backtest Engine
- [ ] Record all WS events to file/DB
- [ ] Replay events through strategy with parameter overrides
- [ ] Output: PnL curve, win rate, max drawdown, Sharpe ratio
- [ ] CLI command: `npm run backtest -- --from=2026-05-01 --to=2026-05-27`

---

## Execution Order (Priority)
1. Phase 1 (quick fixes) — 15 min
2. Phase 2 (risk persistence) — 2-3 hours
3. Phase 3.1 (bundle detection) — 2 hours ← HIGH IMPACT
4. Phase 3.2 (wash trade detector) — 2 hours ← HIGH IMPACT
5. Phase 3.5 (market cap tier) — 1 hour
6. Phase 4.1 (smart money tracking) — 3 hours ← HIGH IMPACT
7. Phase 4.2 (cabal detection) — 2 hours
8. Phase 5.2 (day phase trade) — 2 hours
9. Phase 6.1 (rent refund) — 1 hour
10. Phase 6.2 (multi-wallet) — 3 hours
11. Phase 6.3 (Jito) — 2 hours
12. Phase 7.1 (Prometheus) — 1 hour
13. Phase 7.2 (backtest) — 3 hours
