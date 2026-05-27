# 🎯 Pumpfun Sniper

> Production-oriented Solana Pump.fun selective sniper infrastructure.
> Bootstrap capital safely through selective momentum-based execution.

## Overview

A TypeScript-based automated trading system that monitors Pump.fun token launches on Solana, applies rigorous multi-layer filtering, and executes precision trades on tokens that pass all safety and momentum checks.

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
│  Max Exposure • Creator Blacklist                         │
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

## Entry Logic — 9 Required Checks

Every token must pass **ALL** checks before a buy is executed:

1. ✅ Launch detected (Pump.fun bonding curve creation)
2. ✅ Creator not blacklisted
3. ✅ Creator history acceptable (≤2 launches in 1hr)
4. ✅ Mint authority safe (revoked)
5. ✅ Freeze authority safe (revoked)
6. ✅ Metadata sane (name/symbol/URI valid, no scam patterns)
7. ✅ Liquidity sane (≥0.1 SOL reserves)
8. ✅ Wallet concentration acceptable (top 5 holders <80%)
9. ✅ Momentum threshold met (≥7 buys + ≥1 SOL volume in 15s)

## Execution Model

| Phase | Venue | Method |
|-------|-------|--------|
| **Entry** | Pump.fun bonding curve | Official SDK quote + instruction |
| **Exit (bonding)** | Pump.fun bonding curve | Official SDK quote + instruction |
| **Exit (graduated)** | Jupiter V6 | Swap API |

## Risk Parameters

| Parameter | Value |
|-----------|-------|
| Position size | $1 USD (fixed) |
| Take profit | +70% |
| Stop loss | -30% |
| Timeout | 1 hour |
| Max concurrent | 1 position |
| Slippage | 500 bps (5%) |
| Daily kill switch | -$40 |
| Cooldown after SL | 5 minutes |
| Momentum window | 15 seconds |
| Min buy count | 7 buys |
| Min volume | 1 SOL |
| Math | BigInt only (no floating point) |

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
# DATABASE_URL=postgresql://pumpfun:pumpfun123@localhost:5432/pumpfun

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
| Tests | 118 (all passing) |
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

## License

Private — All rights reserved.
