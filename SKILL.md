# Pumpfun Sniper Bot

Solana bonding curve sniper bot for pump.fun. Detects momentum signals, filters through 18 entry checks, executes buys, and manages exits via TP/SL/trailing stop/scale-out.

Repo: https://github.com/0xmultiserver-crypto/pumpfun.git

## Quick Start

```bash
# Local
service postgresql start && service redis-server start
cd /root/workspace/pumpfun && npm run build && node dist/main.js

# VPS (production)
ssh ubuntu@43.156.32.4
cd /home/ubuntu/workspace/pumpfun && { node dist/main.js > /tmp/pumpfun-vps.log 2>&1 & }
```

## Architecture

```
src/
  main.ts                    — Bootstrap + wiring only
  app/
    bootstrap.ts             — Config loading + container creation
    container.ts             — DI container (lazy singletons)
    lifecycle.ts             — Signal handlers (SIGINT/SIGTERM)
    dataProvider.ts          — RPC/data fetching, calls evaluators
    entryCheckEvaluator.ts   — Pure evaluation: authority, liquidity, launch, metadata, concentration
    executionDelegate.ts     — Thin facade wiring StrategyExecutionDelegate
    solPriceOracle.ts        — CoinGecko → $85 fallback (2026-05-29)
    heliusHolderCount.ts     — Real holder count via Helius API
    realVolumeFetcher.ts     — Real 1h volume via DexScreener
    wsManager.ts             — WebSocket with auto-reconnect
    positionRecovery.ts      — Startup recovery from DB
    execution/
      buyExecutor.ts         — BUY orchestration
      sellExecutor.ts        — SELL orchestration + routing
      runtime.ts             — Shared ExecutionRuntime interface
      riskGuardRunner.ts     — 5-guard check
      tradeRecorder.ts       — DB trade persistence
      pnlRecorder.ts         — P&L recording + cooldown
      onChainAccounting.ts   — Confirmed tx metadata accounting
      rentReclaimer.ts       — Rent reclamation on close
  core/
    state/positionRegistry.ts — Active positions tracker
    constants/defaults/      — ALL shared constants (LOCKED values)
    constants/programs.ts    — Solana program IDs
    types/                   — Pure data shapes
  strategies/filteredSniper/ — Business logic
    entryDecision.ts         — 18-check entry filter
    exitDecision.ts          — TP/SL/trailing/timeout/graduated/scale-out
    filteredSniperRules.ts   — Strategy rules (derives from defaults.ts)
  risk/controls/             — Risk guards (kill switch, daily loss, cooldown, throttle)
  execution/venues/          — PumpfunVenue + JupiterVenue
  execution/tx/              — Transaction assembly
  adapters/protocols/pumpfun/ — Protocol integration (SDK, instruction builders, event decoders)
  ingestion/
    wsMessageHandler.ts      — WS message parsing + event routing
    pipeline/                — Event normalizer + dispatcher
    rpc/                     — RPC client
```

## Pipeline Flow

```
WS Event → Momentum Detector → Bundle Detection → Entry Check (18 filters)
  → Risk Guards (5 checks) → BUY TX → On-Chain Confirm → Exit Monitor (2s poll)
  → TP/SL/Trailing/Timeout/Graduated/Scale-Out → SELL TX → On-Chain Confirm → Cooldown
```

### 18 Entry Checks
1. Launch detected
2. Creator not blacklisted
3. Creator history acceptable (including creator score ≥ 45)
4. Mint authority safe (revoked)
5. Freeze authority safe (revoked)
6. Metadata sane
7. Liquidity sane (minimum reserves on bonding curve)
8. Wallet concentration acceptable (< 60% top 5)
9. Momentum threshold met (10+ buys, 10s window, 2+ SOL volume)
10. Price impact acceptable (≤ 500 bps)
11. Bundle percentage acceptable (≤ 30%)
12. Wash trade score acceptable (≤ 60)
13. Unique wallets sufficient (≥ 12)
14. Sell pressure acceptable (≤ 60% sells in window)
15. Liquidity depth sufficient (≥ 0.5 SOL real reserves)
16. Holder-to-bundle ratio acceptable
17. Holder-MCap ratio (≤ 0.015 holders/$ — catches coordinated inflation)
18. Volume-MCap ratio (≤ 5x — catches wash trade volume)

### 5 Risk Guards (checked in order)
1. EmergencyKillSwitch — global on/off
2. DailyLossGuard — $40/day loss limit
3. CooldownManager — 2 min cooldown after exit
4. TradeThrottle — 3 trades/60s, 5s min gap
5. MaxExposureGuard — 2 concurrent positions max

### Exit Priority Order
1. GRADUATED (bonding curve complete → route to Jupiter)
2. KILL_SWITCH (emergency)
3. SCALE_OUT (partial exits at +100% sell 50%, +500% sell 25%)
4. TRAILING_STOP (50% from highest, activates at +100%)
5. STOP_LOSS (-80% from entry)
6. TAKE_PROFIT (+1500% from entry)
7. TIMEOUT (6 hours)

## Current Locked Parameters

| Parameter | Value | File |
|---|---|---|
| Take Profit | +1500% | `defaults/trading.ts` |
| Stop Loss | -80% | `defaults/trading.ts` |
| Trailing activation | +100% | `defaults/trading.ts` |
| Trailing distance | 50% | `defaults/trading.ts` |
| Position size | $1.20 USD (dynamic: $0.10–$5.00) | `defaults/trading.ts` |
| Cooldown | 2 min (120s) | `defaults/risk.ts` |
| Max concurrent | 2 | `defaults/trading.ts` |
| Priority fee | 200k micro-lamports/CU | `defaults/infrastructure.ts` |
| Slippage | 500 bps (5%) | `defaults/trading.ts` |
| Momentum min buys | 10 | `defaults/detection.ts` |
| Momentum window | 10s | `defaults/detection.ts` |
| Momentum min volume | 2 SOL | `defaults/detection.ts` |
| Max wallet concentration | 60% top 5 | `defaults/detection.ts` |
| Daily kill limit | $40/day | `defaults/risk.ts` |
| Scale-out enabled | true | `defaults/trading.ts` |

## VPS Deployment

VPS: `43.156.32.4` (Ubuntu 24.04, 2GB RAM, Tencent Cloud)
User: `ubuntu`, Password: `tiger-78#-mountain`

### Setup (one-time)

```bash
# Install infra
ssh ubuntu@43.156.32.4
sudo apt-get install -y postgresql postgresql-contrib redis-server

# Create DB
sudo -u postgres psql -c "CREATE USER pumpfun WITH PASSWORD 'pumpfun123';"
sudo -u postgres psql -c "CREATE DATABASE pumpfun OWNER pumpfun;"

# Apply schema
PGPASSWORD=pumpfun123 pg_dump -h localhost -U pumpfun -d pumpfun --schema-only > /tmp/schema.sql
scp /tmp/schema.sql ubuntu@43.156.32.4:/tmp/
ssh ubuntu@43.156.32.4 "PGPASSWORD=pumpfun123 psql -h localhost -U pumpfun -d pumpfun -f /tmp/schema.sql"

# Copy project + build
rsync -avz --exclude='node_modules' --exclude='.git' /root/workspace/pumpfun/ ubuntu@43.156.32.4:/home/ubuntu/workspace/pumpfun/
ssh ubuntu@43.156.32.4 "cd /home/ubuntu/workspace/pumpfun && npm install && npm run build"
```

### Deploy Updates

```bash
sshpass -p 'tiger-78#-mountain' rsync -avz --exclude='node_modules' --exclude='.git' /root/workspace/pumpfun/ ubuntu@43.156.32.4:/home/ubuntu/workspace/pumpfun/
sshpass -p 'tiger-78#-mountain' ssh ubuntu@43.156.32.4 "cd /home/ubuntu/workspace/pumpfun && npm run build"
```

### Run/Stop Bot

```bash
# Start
sshpass -p 'tiger-78#-mountain' ssh ubuntu@43.156.32.4 "cd /home/ubuntu/workspace/pumpfun && nohup node dist/main.js > /tmp/pumpfun-vps.log 2>&1 & echo PID=\$!"

# Check status
sshpass -p 'tiger-78#-mountain' ssh ubuntu@43.156.32.4 "grep -i -E 'BUY.*SUCCESS|Exit.*decision|SELL.*CONFIRM|cooldown' /tmp/pumpfun-vps.log | tail -20"

# Monitor stats
sshpass -p 'tiger-78#-mountain' ssh ubuntu@43.156.32.4 "wc -l /tmp/pumpfun-vps.log; grep -c 'BUY SUCCESS\|SELL TX CONFIRMED\|block height exceeded' /tmp/pumpfun-vps.log"

# Stop
sshpass -p 'tiger-78#-mountain' ssh ubuntu@43.156.32.4 "ps aux | grep 'node dist/main' | grep -v grep | awk '{print \$2}' | xargs -r kill"
```

## Wallet Management

```bash
# Generate new wallet
node -e "const {Keypair}=require('@solana/web3.js');const bs58=require('bs58');const kp=Keypair.generate();console.log('Address:',kp.publicKey.toBase58());console.log('PK:',bs58.encode(kp.secretKey));"

# Convert bs58 to base64 for .env
node -e "const bs58=require('bs58');const pk=bs58.decode('YOUR_BS58_PK');console.log(Buffer.from(pk).toString('base64'));"
```

## Testing

```bash
npm run typecheck   # 0 errors
npm test -- --run   # 135 tests, 19 test files
npm run build       # Must pass before deploy
```

## Key Pitfalls

### Priority Fee (Critical)
`computeUnitPrice: 50_000n` causes TX to expire (block height exceeded). Must use `200_000n`. Even VPS fails at 50k.

### Trailing Stop Exit-Below-Activation
When price barely crosses +100% activation and immediately drops, exit PnL can be BELOW +100%. Example: peak=+102%, drop 50% from peak → exit at +1%. This is correct — trailing locks whatever profit exists after peak.

### Token-2022 Metadata
New pump.fun mints use Token-2022. Metadata is in mint extension, not Metaplex PDA. `evaluateMetadata()` handles both paths.

### Bundle Detection
Tracks unique slots per token. Blocks when `bundleRatio >= 3 AND uniqueSlots <= 2`. Catches coordinated multi-wallet buys.

### Graduated Token Detection
When bonding curve completes during trade, reserves drain → price=0 → false STOP_LOSS. Fix: check `complete` flag before PnL calc, return GRADUATED reason, route to Jupiter.

### Exit Monitor is Silent
Exit monitor polls every 2s but only logs when TP/SL/trailing/timeout triggers. Silence = holding, not broken.

### Constants Propagation
`defaults/` is source of truth but some files have local copies. After changing constants, always grep for old values.

### Custom 6002 Retry
First BUY attempt may fail with Custom 6002 (fee drift). Bot auto-retries with fresh blockhash + new quote. Don't panic.

### Cooldown After Any Exit
Cooldown triggers after STOP_LOSS, TRAILING_STOP, TIMEOUT (not just SL). 2 min cooldown blocks subsequent buys.

### Scale-Out Partial Exits
Bot sells partial positions at profit tiers (+100% → sell 50%, +500% → sell 25%). Remaining position rides with trailing stop. Scale-out does NOT trigger cooldown.

## Environment

- PostgreSQL: user=pumpfun, password=pumpfun123, db=pumpfun, localhost:5432
- Redis: localhost:6379
- Wallet: Base64-encoded 64-byte secret key in WALLET_SECRET_KEY
- RPC: Helius (primary) + PublicNode (fallback)
- WS: Helius WebSocket for real-time subscriptions
