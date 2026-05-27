# Pumpfun Sniper Bot

Solana bonding curve sniper bot for pump.fun. Detects momentum signals, filters through 9 entry checks, executes buys, and manages exits via TP/SL/trailing stop.

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
    solPriceOracle.ts        — CoinGecko → $150 fallback
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
  core/
    state/positionRegistry.ts — Active positions tracker
    constants/defaults.ts    — ALL shared constants (LOCKED values)
    constants/programs.ts    — Solana program IDs
    types/                   — Pure data shapes
  strategies/filteredSniper/ — Business logic
    entryDecision.ts         — 9-check entry filter
    exitDecision.ts          — TP/SL/trailing/timeout/graduated
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
WS Event → Momentum Detector → Bundle Detection → Entry Check (9 filters)
  → Risk Guards (5 checks) → BUY TX → On-Chain Confirm → Exit Monitor (2s poll)
  → TP/SL/Trailing/Timeout/Graduated → SELL TX → On-Chain Confirm → Cooldown
```

### 9 Entry Checks
1. Signal type = MOMENTUM
2. Launch detected
3. Creator launch count
4. Mint authority revoked
5. Freeze authority revoked
6. Metadata sane (Token-2022 supported)
7. Liquidity sane
8. Wallet concentration < 80% top 5
9. Momentum: 7+ buys, 15s window, 1+ SOL volume

### 5 Risk Guards (checked in order)
1. EmergencyKillSwitch — global on/off
2. DailyLossGuard — $40/day loss limit
3. CooldownManager — 5 min cooldown after exit
4. TradeThrottle — 3 trades/60s, 5s min gap
5. MaxExposureGuard — 2 concurrent positions max

### Exit Priority Order
1. GRADUATED (bonding curve complete → route to Jupiter)
2. KILL_SWITCH (emergency)
3. TRAILING_STOP (10% from highest, activates at +30%)
4. STOP_LOSS (-50% from entry)
5. TAKE_PROFIT (+500% from entry)
6. TIMEOUT (1 hour)

## Current Locked Parameters

| Parameter | Value | File |
|---|---|---|
| Take Profit | +500% | `defaults.ts` |
| Stop Loss | -50% | `defaults.ts` |
| Trailing activation | +30% | `defaults.ts` |
| Trailing distance | 10% | `defaults.ts` |
| Position size | $1 USD | `.env` |
| Cooldown | 5 min | `defaults.ts` |
| Max concurrent | 2 | `defaults.ts` |
| Priority fee | 150k micro-lamports/CU | `defaults.ts` |
| Slippage | 500 bps (5%) | `defaults.ts` |
| Momentum min buys | 7 | `defaults.ts` |
| Momentum window | 15s | `defaults.ts` |
| Momentum min volume | 1 SOL | `defaults.ts` |

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
`computeUnitPrice: 50_000n` causes TX to expire (block height exceeded). Must use `150_000n`. Even VPS fails at 50k.

### Trailing Stop Exit-Below-Activation
When price barely crosses +30% activation and immediately drops, exit PnL can be BELOW +30%. Example: peak=+32%, drop 10% from peak → exit at +17%. This is correct — trailing locks whatever profit exists after peak.

### Token-2022 Metadata
New pump.fun mints use Token-2022. Metadata is in mint extension, not Metaplex PDA. `evaluateMetadata()` handles both paths.

### Bundle Detection
Tracks unique slots per token. Blocks when `bundleRatio >= 3 AND uniqueSlots <= 2`. Catches coordinated multi-wallet buys.

### Graduated Token Detection
When bonding curve completes during trade, reserves drain → price=0 → false STOP_LOSS. Fix: check `complete` flag before PnL calc, return GRADUATED reason, route to Jupiter.

### Exit Monitor is Silent
Exit monitor polls every 2s but only logs when TP/SL/trailing/timeout triggers. Silence = holding, not broken.

### Constants Propagation
`defaults.ts` is source of truth but some files have local copies. After changing constants, always grep for old values.

### Custom 6002 Retry
First BUY attempt may fail with Custom 6002 (fee drift). Bot auto-retries with fresh blockhash + new quote. Don't panic.

### Cooldown After Any Exit
Cooldown triggers after STOP_LOSS, TRAILING_STOP, TIMEOUT (not just SL). 5 min cooldown blocks subsequent buys.

## Environment

- PostgreSQL: user=pumpfun, password=pumpfun123, db=pumpfun, localhost:5432
- Redis: localhost:6379
- Wallet: Base64-encoded 64-byte secret key in WALLET_SECRET_KEY
- RPC: Helius (primary) + PublicNode (fallback)
- WS: Helius WebSocket for real-time subscriptions
