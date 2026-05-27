     1|# PumpFun Bot — Implementation Roadmap
     2|
     3|Generated from ponyin.id trading intel + bot audit (2026-05-27).
     4|
     5|## Status Legend
     6|- [ ] TODO
     7|- [~] IN PROGRESS
     8|- [x] DONE
     9|
    10|---
    11|
    12|## PHASE 1 — Quick Wins (current session)
    13|
    14|### 1.1 Fix Signal Error Handling
    15|- [x] Replace `void strategy.onSignal()` with `.catch()` + logger.error
    16|- [x] Add debug log at onSignal entry (mint, signalType, state)
    17|- [x] Build + restart bot
    18|
    19|### 1.2 Fix 7 Failing Tests
    20|- [x] `computeBudget.test.ts` — update expectations to 150000n (not 50000n)
    21|- [x] `cooldownManager.test.ts` — update to 120s cooldown (not 300s)
    22|- [x] `entryExitDecision.test.ts` — fix trailing stop tests to match new constants
    23|
    24|### 1.3 Fix Constants Comment Mismatches (`defaults.ts`)
    25|- [x] Line 17: comment says "$20" → fix to "$1"
    26|- [x] Line 21: comment says "+50%" → fix to "+500%"
    27|- [x] Line 33: comment says "10 minutes (600 seconds)" → fix to "60 minutes (3600 seconds)"
    28|- [x] Line 36: comment says "2" → fix to "1"
    29|- [x] Audit ALL comments vs values in defaults.ts
    30|
    31|---
    32|
    33|## PHASE 2 — Risk Persistence
    34|
    35|### 2.1 Persist Risk State to DB
    36|- [x] Add `risk_state` table (key-value with JSONB)
    37|- [x] Persist DailyLossGuard daily PnL + trade count + stop loss count
    38|- [x] Persist CreatorBlacklist entries
    39|- [x] Persist CooldownManager expiry timestamp
    40|- [x] On startup: restore all risk state from DB
    41|- [x] On state change: write-through to DB
    42|
    43|---
    44|
    45|## PHASE 3 — Ponyin Intel: Entry Filters
    46|
    ### 3.1 Bundle Detection (from ponyin.id #1)
    **Concept:** Dev splits supply ke puluhan wallet, beli di milidetik pertama launch.
    Dari luar terlihat organik, padahal 1 komando.
    - [x] Cluster wallet berdasarkan: same block purchase, same funding source
    - [x] Calculate bundlePct = % supply yang dibeli dalam window pertama oleh wallet cluster
    - [x] Entry check baru: bundlePct > 30% = REJECT (configurable)
    - [x] Log: "Bundle detected: X wallets bought Y% supply in Zms"
    54|
    ### 3.2 Global Fee / Wash Trade Detector (from ponyin.id #2)
    **Concept:** Volume palsu = volume tinggi tapi fee sangat kecil.
    Fee sebanding dengan volume = organic. Fee kecil + volume besar = wash trade.
    - [x] Detector baru: `washTradeDetector`
    - [x] Metric: feeVolumeRatio = totalFee / totalVolume
    - [x] Kalau ratio < threshold (e.g. 0.1%) = suspicious volume
    - [x] Entry check: washTradeScore > threshold = REJECT
    - [x] Data source: DexScreener API atau on-chain fee calculation
    63|
    64|### 3.3 Dex Paid / Ads / Boost Timing (from ponyin.id #5)
    65|**Concept:** Dex Paid positif kalau di awal launch. Muncul SETELAH pump besar = FOMO trap.
    66|- [x] Track dexPaidTimestamp vs token launch timestamp
    67|- [x] Kalau gap > 30 menit = "late dex paid" = suspicious
    68|- [x] Entry check: lateDexPaid = REJECT atau reduce confidence
    69|- [x] Data source: DexScreener API (dexPaid field)
    70|
    71|### 3.4 Revoke Timing Analysis (from ponyin.id #3)
    72|**Concept:** Revoke sudah dilakukan ≠ token aman.
    73|Revoke SETELAH dev dump = jebakan. Revoke SEBELUM launch = positive signal.
    74|- [x] Track revokeTimestamp vs launchTimestamp vs firstDumpTimestamp
    75|- [x] Kalau revoke setelah ada large sell = suspicious
    76|- [x] Enhance existing check #4 (mint authority) dengan timing analysis
    77|
    78|### 3.5 Market Cap Tier Strategy (from ponyin.id #9)
    79|**Concept:** Beda market cap = beda lawan, beda strategi.
    80|- [x] Micro (<$100K): snipe only, position size kecil
    81|- [x] Small ($100K-$1M): momentum play, position size medium
    82|- [x] Mid ($1M-$10M): swing trade, position size besar
    83|- [x] Dynamic position sizing by market cap tier
    84|- [x] Dynamic TP/SL by market cap tier
    85|
    86|---
    87|
    88|## PHASE 4 — Ponyin Intel: Detectors
    89|
    90|### 4.1 Smart Money / Wallet Ping Detector (from ponyin.id A3)
    91|**Concept:** Track wallet yang sering masuk awal di token runner.
    92|10 mata lebih baik dari 2 mata.
    93|- [x] Build "smart wallet" database dari historical winners
    94|- [x] Track wallets yang masuk di top 20 trader per token runner
    95|- [x] Detector baru: `smartMoneyDetector`
    96|- [x] Kalau smart wallet beli token baru → momentum signal boost
    97|- [x] Auto-discover: dari wallet yang profitable, trace wallet lain yang sering berinteraksi
    98|
    99|### 4.2 Cabal Wallet Cluster Detection (from ponyin.id #7)
   100|**Concept:** Cabal = kelompok tertutup yang rencanakan launch terkoordinasi.
   101|3 tipe: Group Cabal, Solo Cabal, Conflict Cabal.
   102|- [x] Track wallet yang sering muncul bareng di token yang sama
   103|- [x] Build "cabal score" per wallet cluster
   104|- [x] Detector baru: `cabalDetector`
   105|- [x] Kalau 3+ wallet dari cluster sama beli bersamaan = cabal play
   106|- [x] Extend creator blacklist → cabal cluster blacklist
   107|
   108|### 4.3 Holder Concentration Enhancement (from ponyin.id #8)
   109|**Concept:** Rule "holder < 5%" sudah outdated di era multi-wallet.
   110|1 orang bisa pegang 20% lewat 10 wallet masing-masing 2%.
   111|- [x] Enhance check #8 (wallet concentration) dengan wallet clustering
   112|- [x] Cluster by funding source (wallet yang di-fund dari sumber sama)
   113|- [x] Calculate "effective concentration" = clustered %, bukan individual %
   114|- [x] Kalau effective concentration > 40% = REJECT
   115|
   116|---
   117|
   118|## PHASE 5 — Ponyin Intel: Exit Strategy
   119|
   120|### 5.1 3 Candle Confirmation Exit (from ponyin.id #6)
   121|**Concept:** Jangan exit di candle merah pertama. Tunggu konfirmasi.
   122|- [x] Track candle pattern (OHLC dari bonding curve price)
   123|- [x] Kalau candle merah pertama + volume turun = watch, jangan panic sell
   124|- [x] Kalau 3 candle merah berturut + volume naik = exit signal
   125|- [x] Enhance exitDecision.ts dengan candle pattern analysis
   126|
   127|### 5.2 Day Phase Trade Strategy (from ponyin.id #✦)
   128|**Concept:** Entry di fase cooldown → sideways. Bukan parabolic.
   129|Cari token trending 1-2 minggu lalu, dip 50-70% dari ATH.
   130|- [x] Detector baru: `dayPhaseDetector`
   131|- [x] Criteria: FDV > $1M, dip 50-70% dari ATH, sideways 3-5 hari
   132|- [x] Community masih aktif (Twitter/TG engagement)
   133|- [x] Holder count stabil atau naik tipis
   134|- [x] Exit target: 2-3x dari entry (bukan 10x)
   135|
   136|### 5.3 Compounding Profit Strategy (from ponyin.id A4)
   137|**Concept:** 35% take profit dipindah ke wallet terpisah.
   138|Sisanya compound ke trade berikutnya.
   139|- [x] On take profit: 35% → cold wallet, 65% → trading wallet
   140|- [x] Track compounding balance per wallet
   141|- [x] Target 50% per trade dari 80% modal
   142|- [x] Integrate dengan scale-out exit logic
   143|
   144|---
   145|
   146|## PHASE 6 — Execution Improvements
   147|
   148|### 6.1 Rent Refund (from ponyin.id A6)
   149|**Concept:** Setiap buy di Solana ada rent (~0.002 SOL per account).
   150|Bisa di-reclaim setelah sell.
   151|- [x] Post-sell: close token accounts dan reclaim rent (fire-and-forget)
   152|- [x] Batch rent reclaim on startup (scan + close stale empty accounts)
   153|- [x] Track total rent recovered per session (Prometheus counter: pumpfun_rent_reclaimed_lamports)
   154|
   155|### 6.2 Multi-Wallet Buy Distribution (from ponyin.id A8)
   156|**Concept:** Spread buy ke beberapa wallet supaya terlihat organik.
   157|Bisa trigger bot lain untuk ikut beli.
   158|- [x] Support N wallets (configurable)
   159|- [x] Distribute buys round-robin atau by wallet balance
   160|- [x] Per-wallet exposure tracking
   161|- [x] Independent risk guards per wallet
   162|
   163|### 6.3 MEV Protection (Jito Bundles)
   164|- [x] Add Jito block engine client
   165|- [x] Submit buy/sell TXs as Jito bundles
   166|- [x] Configurable tip amount (default 10k lamports)
   167|- [x] Fallback to normal submission if Jito fails
   168|
   169|### 6.4 Dynamic Compute Unit Estimation
   170|- [x] Estimate CU per TX type (buy/sell) from historical data
   171|- [x] Replace fixed CU limit with estimated + buffer
   172|- [x] Track actual CU used per TX for calibration
   173|
   174|---
   175|
   176|## PHASE 7 — Infrastructure
   177|
   ### 7.1 Metrics (Prometheus)
   - [x] Add prom-client dependency
   - [x] Expose /metrics HTTP endpoint (port 9090, configurable via METRICS_PORT)
   - [x] Track: events/sec, signals, buys, sells, PnL, win rate, bundle detection
   - [x] Grafana dashboard JSON template
   183|
   ### 7.2 Backtest Engine
   - [x] Record all WS events to file/DB
   - [x] Replay events through strategy with parameter overrides
   - [x] Output: PnL curve, win rate, max drawdown, Sharpe ratio
   - [x] CLI command: `npm run backtest -- --from=2026-05-01 --to=2026-05-27`
   189|
   190|---
   191|
   192|## Execution Order (Priority)
   193|1. Phase 1 (quick fixes) — 15 min
   194|2. Phase 2 (risk persistence) — 2-3 hours
   195|3. Phase 3.1 (bundle detection) — 2 hours ← HIGH IMPACT
   196|4. Phase 3.2 (wash trade detector) — 2 hours ← HIGH IMPACT
   197|5. Phase 3.5 (market cap tier) — 1 hour
   198|6. Phase 4.1 (smart money tracking) — 3 hours ← HIGH IMPACT
   199|7. Phase 4.2 (cabal detection) — 2 hours
   200|8. Phase 5.2 (day phase trade) — 2 hours
   201|9. Phase 6.1 (rent refund) — 1 hour
   202|10. Phase 6.2 (multi-wallet) — 3 hours
   203|11. Phase 6.3 (Jito) — 2 hours
   204|12. Phase 7.1 (Prometheus) — 1 hour
   205|13. Phase 7.2 (backtest) — 3 hours
   206|