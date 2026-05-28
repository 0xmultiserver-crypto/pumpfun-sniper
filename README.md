# 🎯 Pumpfun Sniper

> Production-oriented Solana Pump.fun selective sniper infrastructure.
> Bootstrap capital safely through selective momentum-based execution.

## Overview

A TypeScript-based automated trading system that monitors Pump.fun token launches on Solana, applies rigorous multi-layer filtering (18 entry checks), and executes precision trades on tokens that pass all safety and momentum checks.

Supports both classic SPL and Token-2022 mints. Entry via Pump.fun bonding curve, exit via bonding curve or Jupiter (graduated tokens).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     APP LAYER                            │
│          DI Container • Bootstrap • Lifecycle             │
│  dataProvider • entryCheckEvaluator • solPriceOracle      │
├─────────────────────────────────────────────────────────┤
│                   STRATEGY LAYER                          │
│       Filtered Sniper • Entry/Exit Decisions              │
├─────────────────────────────────────────────────────────┤
│                   EXECUTION LAYER                         │
│  buyExecutor • sellExecutor • riskGuardRunner              │
│  tradeRecorder • pnlRecorder • TX build • send            │
├─────────────────────────────────────────────────────────┤
│                    RISK LAYER                             │
│  Kill Switch • Daily Loss • Cooldown • Throttle           │
│  Max Exposure • Creator Blacklist • Anti-Rug              │
├─────────────────────────────────────────────────────────┤
│                  DETECTORS LAYER                          │
│      Launch • Momentum • Volume • Holder Growth           │
├─────────────────────────────────────────────────────────┤
│                  ADAPTERS LAYER                           │
│    Pump.fun Protocol • Jupiter DEX • Token-2022           │
├─────────────────────────────────────────────────────────┤
│                  INGESTION LAYER                          │
│        WebSocket • RPC • Event Pipeline                   │
├─────────────────────────────────────────────────────────┤
│                  TELEMETRY LAYER                          │
│                      Logging                              │
├─────────────────────────────────────────────────────────┤
│                   STORAGE LAYER                           │
│               PostgreSQL • Redis                          │
├─────────────────────────────────────────────────────────┤
│                    CORE LAYER                             │
│        Types • Interfaces • Constants • Utils             │
└─────────────────────────────────────────────────────────┘
```

## Entry Logic — 18 Required Checks

Every token must pass **ALL** checks before a buy is executed:

### Basic Safety (1–6)
1. ✅ Launch detected (Pump.fun bonding curve creation)
2. ✅ Creator not blacklisted
3. ✅ Creator history acceptable (≤2 launches in 1hr)
4. ✅ Mint authority safe (revoked)
5. ✅ Freeze authority safe (revoked)
6. ✅ Metadata sane (name/symbol/URI valid, no scam patterns)

### Liquidity & Concentration (7–9)
7. ✅ Liquidity depth (≥0.5 SOL reserves)
8. ✅ Wallet concentration (top 5 holders ≤60%)
9. ✅ Creator score (≥45)

### On-Chain Analysis (10–12)
10. ✅ Bundle analysis (≤30% — forceAnalyze)
11. ✅ Wash trade detection (score ≤60 — forceAnalyze)
12. ✅ Unique wallets (≥12 distinct buyers)

### Volume & Holders (13–15)
13. ✅ Sell pressure (≤60% of volume)
14. ✅ Holder/MCap ratio (≤0.015 — Helius real holder count)
15. ✅ Volume/MCap ratio (≤5x — DexScreener real 1h volume)

### Momentum & Final (16–18)
16. ✅ Momentum threshold (≥10 buys + ≥2 SOL volume in 10s)
17. ✅ Balance sufficient (position + ATA rent + TX fees)
18. ✅ No active cooldown (120s between trades)

## Execution Model

| Phase | Venue | Method |
|-------|-------|--------|
| **Entry** | Pump.fun bonding curve | Official SDK quote + instruction |
| **Exit (bonding)** | Pump.fun bonding curve | Official SDK quote + instruction |
| **Exit (graduated)** | Jupiter V6 | Swap API |

## Risk Parameters

| Parameter | Value |
|-----------|-------|
| Position size | $1.20 USD (dynamic $0.10–$5.00) |
| Take profit | +1500% |
| Stop loss | -80% |
| Trailing stop | Activate at +100%, drop 50% |
| Scale-out | 50% at +100%, 25% at +500% |
| Timeout | 6 hours |
| Max concurrent | 2 positions |
| Slippage | 500 bps (5%) |
| Daily kill switch | -$40 |
| Cooldown after SL | 120 seconds |
| Momentum window | 10 seconds |
| Min buy count | 10 buys |
| Min volume | 2 SOL |
| SOL fallback price | $85 |
| Math | BigInt only (no floating point) |

## External Data & Rate Limiting

| Source | Rate Limit | Cache TTL |
|--------|-----------|-----------|
| Helius API | 2 RPS | 120 seconds |
| DexScreener | 2 RPS | 120 seconds |

- SOL price: Jupiter → CoinGecko → fallback $85
- Holder count: Helius real holder endpoint (no estimation)
- Volume: DexScreener real 1h volume (no estimation)

## Anti-Rug Protection

- **Enabled** — continuous monitoring after entry
- **Dump threshold:** 10% price drop triggers immediate evaluation
- **Sell retry:** exponential backoff, never gives up until sold
- **Balance check:** validates position + ATA rent + TX fees before each trade

## Tech Stack

- **Runtime:** Node.js (TypeScript, strict mode)
- **Blockchain:** Solana (`@solana/web3.js`)
- **DEX:** Jupiter V6 API
- **Protocol:** Pump.fun (official SDK v1.36.0)
- **Database:** PostgreSQL
- **Cache:** Redis (ioredis)
- **Transport:** WebSocket (`ws`)
- **Logging:** pino-style structured logger

## Quick Start

```bash
# Install
npm install

# Start infra
service postgresql start && service redis-server start

# Configure .env
# HELIUS_API_KEY=...
# WALLET_SECRET_KEY=<base64-encoded-64-byte-key>
# DATABASE_URL=postgresql://pumpfun:***@localhost:5432/pumpfun

# Typecheck + test + build
npm run typecheck && npm test -- --run && npm run build

# Run
node dist/main.js
```

## Project Stats

| Metric | Value |
|--------|-------|
| Production files | 91 |
| Test files | 17 |
| Tests | 169 (all passing) |
| TSC errors | 0 |
| Lines of code | ~11,600 |

## Design Principles

- **Strict TypeScript** — `noUncheckedIndexedAccess`, no `any`
- **BigInt everywhere** — zero floating-point finance math
- **Layer isolation** — each layer only depends on layers below it
- **Fail-closed** — missing data = reject, not accept
- **Single source of truth** — all config in `core/constants/defaults.ts`
- **Dependency injection** — explicit wiring via container
- **Token-2022 aware** — supports new Pump.fun mint standard
- **Security** — private keys never logged, never serialized
- **Resilient execution** — sell retry with exponential backoff, never abandons a position

## License

Private — All rights reserved.
