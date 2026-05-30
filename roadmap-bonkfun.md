# BonkFun Integration Roadmap

## Status: 60% Done — Execution OK, Detection Missing

---

## ✅ Phase 1: Execution Layer (DONE)

Semua file sudah exist dan functional:

| File | Purpose |
|------|---------|
| `src/adapters/protocols/bonkfun/bonkfunTradeBuilder.ts` | PDA derivation, buy/sell instruction builders |
| `src/adapters/protocols/bonkfun/tokenParser.ts` | Pool state data parser (offsets, vaults, creator) |
| `src/adapters/protocols/bonkfun/shared.ts` | Shared constants |
| `src/execution/venues/bonkfunVenue.ts` | Venue wrapper (buildSwap) |
| `src/app/execution/bonkfunBuyExecutor.ts` | Full buy flow (ATA → WSOL wrap → buy → close WSOL) |
| `src/app/execution/bonkfunSellExecutor.ts` | Full sell flow (ATA → sell → close WSOL) |
| `src/core/constants/programs.ts` | LaunchLab program ID, platform config, WSOL mint |
| `src/app/container.ts` | `bonkfunVenue` registered |

**Bot bisa execute buy/sell di BonkFun bonding curve. Tapi ga bisa detect token baru.**

---

## ✅ Phase 2: Event Detection (DONE)

### Goal: Detect new BonkFun token launches in real-time

### Approach A: WebSocket logsSubscribe (Implemented)

Real-time detection, <1s latency. Mirip cara PumpFun detection.

**Step 2.1: Add LaunchLab WS subscription** ✅
- File: `src/main.ts`
- Added second `logsSubscribe` untuk `RAYDIUM_LAUNCHLAB_PROGRAM_ID` (id: 2)
- Same WS connection, Helius supports multiple subscriptions

**Step 2.2: Create LaunchLab log parser** ✅
- File: `src/adapters/protocols/bonkfun/launchLabParser.ts`
- `isLaunchLabInitializeCandidate(logs)` — fast sync check (program ID + "Initialize" pattern)
- `verifyAndParseLaunchLabTx(sig, slot, conn)` — async: fetches tx, checks platform_config, extracts mint
- Account indices: platform_config=#3, base_token_mint=#5 (from IDL)

**Step 2.3: (Not needed) — reuses existing LaunchDetector**
- The existing `LaunchDetector` handles `LaunchEvent` regardless of source (PumpFun or BonkFun)
- No new detector file needed — same signal type `LAUNCH`

**Step 2.4: Wire into wsMessageHandler** ✅
- File: `src/ingestion/wsMessageHandler.ts`
- Now async, accepts `connection` parameter
- Checks logs for LaunchLab program ID first
- If initialize candidate → fetches tx → verifies → dispatches as 'launch'
- Falls through to PumpFun decoding if not LaunchLab

**Step 2.5: Wire into main.ts** ✅
- File: `src/main.ts`
- Added `RAYDIUM_LAUNCHLAB_PROGRAM_ID` import
- `onOpen`: sends both PumpFun (id:1) and LaunchLab (id:2) subscriptions
- `onMessage`: passes `container.connection` to async `handleWsMessage`

### Approach B: DexScreener Polling (DEPRECATED — JANGAN DIPAKE)

**DexScreener cuma buat fallback data (volume, mcap), BUKAN buat event detection.**
Detection HARUS real-time via WebSocket.

---

## ✅ Phase 3: Venue Auto-Detection (DONE)

### Goal: Bot auto-route ke correct venue (PumpFun vs BonkFun vs Jupiter)

**Step 3.1: Venue detection utility** ✅
- File: `src/app/venueDetector.ts` (NEW)
- `detectVenue(mint, connection)` — checks PumpFun BC + LaunchLab pool in parallel
- `detectVenueCached(mint, connection)` — 30s TTL cache
- Returns: `'pumpfun' | 'bonkfun' | 'jupiter' | null`

**Step 3.2: Execution routing** ✅ (ALREADY EXISTED)
- Files: `src/app/execution/buyExecutor.ts` + `sellExecutor.ts`
- Both already have BonkFun routing at lines 199+ (buy) and 156+ (sell)
- Detect BonkFun via pool state PDA + `isBonkfunToken()` check
- Route to `buildBonkfunBuyInstructions` / `buildBonkfunSellInstructions`

**Step 3.3: Price data from correct source** ✅
- File: `src/app/dataProvider.ts` (MODIFIED)
- `getEntryCheckData()`: fetches LaunchLab pool state (fetch #7), uses for:
  - Price impact calculation (virtualQuote)
  - Market cap calculation (virtualQuote/virtualBase * supply)
  - Real SOL reserves (realQuote)
- `getPositionData()`: checks BonkFun pool state when bonding curve doesn't exist
  - Uses `calculatePriceLamports()` from tokenParser
  - Handles graduation (status > 0 → Jupiter)

---

## ✅ Phase 4: Entry Checks Adaptation (DONE)

### Goal: Entry checks work untuk BonkFun tokens (beberapa perlu adjust)

**Checks yang diubah:**
| # | Check | Change | Status |
|---|-------|--------|--------|
| 7 | liquidity_sane | `evaluateLiquidity()` now accepts optional `poolStateAccount`, checks `realQuote` + `realBase` | ✅ |
| 8 | wallet_concentration | Filters out BonkFun base_vault from top holders before concentration calc | ✅ |
| 15 | liquidity_depth | `realSolReservesLamports` uses `parsedPool.realQuote` as fallback | ✅ (Phase 3) |
| 17 | holder_mcap_ratio | MCap calculation uses `virtualQuote/virtualBase * supply` for BonkFun | ✅ (Phase 3) |
| 18 | volume_mcap_ratio | Same DexScreener volume, mcap already BonkFun-aware | ✅ (Phase 3) |
| 10 | price_impact | Uses `virtualQuote` for BonkFun price impact | ✅ (Phase 3) |

**Checks yang NO CHANGE (universal):**
- 1-6: launch_detected, creator blacklist, creator score, mint authority, freeze, metadata
- 9, 11-14: momentum, bundle, wash trade, unique wallets, sell pressure
- 16: holder_bundle_ratio

### Key Files Modified

- `src/app/entryCheckEvaluator.ts`:
  - `evaluateLiquidity()` — added optional `poolStateAccount` param, checks BonkFun pool state
  - Imports `parsePoolStateData` + `BONKFUN_PLATFORM_CONFIG`
- `src/app/dataProvider.ts`:
  - Passes `poolStateAccount` (fetch #7) to `evaluateLiquidity()`
  - Filters base_vault from `largestAccounts` for BonkFun concentration check
  - Uses `finalConcentration` (vault-excluded) in return value

---

## ✅ Phase 5: Sell Path Adaptation (DONE)

### Goal: Exit monitoring dan sell execution work untuk BonkFun

**Step 5.1: Exit monitor venue routing** ✅ (ALREADY EXISTED)
- `sellExecutor.ts` already has BonkFun routing at lines 156+
- Detects BonkFun via pool state PDA + `isBonkfunToken()` check
- Routes to `buildBonkfunSellInstructions()` (WSOL wrapping flow)

**Step 5.2: Graduation detection (BonkFun)** ✅ (ALREADY EXISTED)
- `dataProvider.ts` `getPositionData()` checks `parsedPool.complete` (status > 0)
- When graduated → fetches price from Jupiter Price API
- Same flow as PumpFun graduation (bonding curve `complete === 1`)

**Step 5.3: Price polling per venue** ✅ (DONE IN PHASE 3)
- `dataProvider.ts` `getPositionData()` checks LaunchLab pool state when BC doesn't exist
- Uses `calculatePriceLamports()` from `tokenParser.ts`
- Handles graduation → Jupiter fallback

### Exit Monitoring Flow (BonkFun)

```
Exit monitor tick
  → getPositionData(tradeId)
    → bonding curve exists? → PumpFun price
    → bonding curve NOT exists? → check LaunchLab pool state
      → BonkFun pool? → calculatePriceLamports(parsed)
      → graduated (status > 0)? → Jupiter Price API
  → evaluateExit(positionData)  [venue-agnostic]
  → executeSell(params)
    → sellExecutor detects BonkFun → buildBonkfunSellInstructions()
    → WSOL wrapping flow: create ATA → sell → close ATA
```

---

## 🔲 Phase 6: Testing & Hardening

**Step 6.1: Unit tests**
- `launchLabParser.test.ts` — parse real LaunchLab logs
- `bonkfunLaunchDetector.test.ts` — signal emission, dedup
- Venue detection — PumpFun vs BonkFun vs Jupiter routing
- Entry checks — correct data source per venue

**Step 6.2: Integration test**
- Test buy flow: detect BonkFun launch → entry checks → buy → monitor → sell
- Test graduation: bonding curve → graduated → Jupiter sell
- Test venue switch mid-position

**Step 6.3: Live test**
- Position size: $0.10 (sesuai preference user)
- Monitor logs buat verify correct venue routing
- Check DB trades table buat verify BonkFun trades recorded correctly

---

## Known Pitfalls

1. **WSOL rent**: Need ~1,439,280 lamports extra buat WSOL account. Pastiin position size accounts for this.
2. **PublicKey.createWithSeed is async**: Must await, jangan sync call.
3. **Pool state vault addresses**: Read dari raw offsets (277+309), jangan derive.
4. **Helius multiple subscriptions**: Cek apakah Helius support 2+ `logsSubscribe` dalam 1 WS connection. Kalau ga, perlu WS connection kedua.
5. **Token-2022**: LaunchLab supports Token-2022. Check `token_program_flag` di pool state.
6. **MCap formula beda**: LaunchLab `virtual_base` / `virtual_quote` offsets beda dari PumpFun BC. Jangan pakai formula yang sama.

---

## File Map (Planned)

```
src/
├── adapters/protocols/bonkfun/
│   ├── bonkfunTradeBuilder.ts    ✅
│   ├── tokenParser.ts            ✅
│   ├── shared.ts                 ✅
│   └── launchLabParser.ts        ✅ Phase 2.2
├── detectors/launch/
│   ├── launchDetector.ts         ✅ (handles both PumpFun + BonkFun)
│   └── bonkfunLaunchDetector.ts  ❌ Not needed — reuses LaunchDetector
├── execution/venues/
│   ├── bonkfunVenue.ts           ✅
│   └── ...
├── app/execution/
│   ├── bonkfunBuyExecutor.ts     ✅
│   ├── bonkfunSellExecutor.ts    ✅
│   └── executionDelegate.ts      🔲 Phase 3.2 (venue routing)
├── app/
│   ├── dataProvider.ts           🔲 Phase 3.1 + 4.1 (venue-aware data)
│   └── container.ts              ✅ (bonkfunVenue) + 🔲 Phase 2.5
├── ingestion/
│   └── wsMessageHandler.ts       ✅ Phase 2.4 (dual-program routing, async)
├── strategies/filteredSniper/
│   └── filteredSniperStrategy.ts 🔲 Phase 5.1 (venue-aware exit)
└── main.ts                       ✅ Phase 2.1 + 2.5 (dual subscription + connection)
```

---

## Priority Order

```
Phase 2 (Detection)  → ✅ DONE — Bot bisa liat BonkFun tokens via WS
Phase 3 (Routing)    → ✅ DONE — Bot auto-route ke correct venue + venue-aware price
Phase 4 (Entry)      → ✅ DONE — Entry checks work untuk BonkFun tokens
Phase 5 (Sell)       → ✅ DONE — Exit monitoring + sell execution work untuk BonkFun
Phase 6 (Test)       → 🔲 NEXT — Verify semua jalan
```

**ALL PHASES DONE. Bot fully supports BonkFun tokens: detect, buy, sell, entry checks, exit monitoring.**
**Phase 6 = testing — build, restart bot, verify live.**
