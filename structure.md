# Project Structure

```
src/
├── main.ts                              # Bootstrap + WS wiring (~235 lines)
│
├── app/                                 # Orchestration & DI
│   ├── bootstrap.ts                     # Config loading + container creation
│   ├── container.ts                     # DI container (lazy singletons)
│   ├── lifecycle.ts                     # SIGINT/SIGTERM handlers
│   ├── dataProvider.ts                  # StrategyDataProvider (RPC fetch)
│   ├── entryCheckEvaluator.ts           # Raw data → boolean evaluation
│   ├── executionDelegate.ts             # StrategyExecutionDelegate facade
│   ├── solPriceOracle.ts                # SOL/USD price (Jupiter → CoinGecko → fallback)
│   ├── wsManager.ts                     # WebSocket with auto-reconnect
│   ├── positionRecovery.ts              # Startup DB recovery + live balance check
│   └── execution/
│       ├── buyExecutor.ts               # BUY orchestration (quote → TX → confirm)
│       ├── sellExecutor.ts              # SELL orchestration (Pumpfun/Jupiter)
│       ├── riskGuardRunner.ts           # 5 risk guards check (shared)
│       ├── tradeRecorder.ts             # DB persistence (shared)
│       ├── pnlRecorder.ts               # P&L + risk state updates (shared)
│       └── runtime.ts                   # ExecutionRuntime interface
│
├── core/                                # Pure types, constants, interfaces
│   ├── config/
│   │   └── env.ts                       # .env loader
│   ├── constants/
│   │   ├── defaults.ts                  # ALL config values (single source of truth)
│   │   ├── programs.ts                  # Solana program IDs
│   │   └── timeouts.ts                  # RPC/shutdown timeouts
│   ├── errors/
│   │   └── rpc.error.ts                 # RPC error types
│   ├── interfaces/
│   │   ├── detector.ts                  # IDetector, SignalHandler
│   │   ├── heuristic.ts                 # IHeuristic, HeuristicResult
│   │   ├── replayStrategy.ts            # IReplayStrategy
│   │   ├── signer.ts                    # ISigner
│   │   ├── storage.ts                   # IStorage
│   │   └── strategy.ts                  # IStrategy
│   ├── state/
│   │   └── positionRegistry.ts          # Active positions (single source of truth)
│   ├── types/
│   │   ├── execution.ts                 # ComputeBudgetParams
│   │   ├── position.ts                  # Position types
│   │   ├── risk.ts                      # DailyPnl, KillSwitchState
│   │   ├── runtime.ts                   # HealthStatus
│   │   ├── signal.ts                    # LaunchEvent, Signal union
│   │   ├── strategy.ts                  # ExitReason
│   │   ├── telemetry.ts                 # Log context types
│   │   ├── token.ts                     # MintAddress, TokenMetadata
│   │   ├── trade.ts                     # TradeRecord
│   │   └── wallet.ts                    # WalletAddress
│   └── utils/
│       ├── dedupe.ts                     # Deduplication helpers
│       ├── serialization.ts             # JSON serialization
│       └── time.ts                      # nowMs()
│
├── strategies/                          # Business logic (NO IO)
│   └── filteredSniper/
│       ├── filteredSniperStrategy.ts    # Main strategy class (entry + exit)
│       ├── filteredSniperRules.ts       # Re-exports from defaults.ts
│       ├── entryDecision.ts             # 9 entry checks evaluation
│       └── exitDecision.ts             # TP/SL/timeout evaluation
│
├── detectors/                           # Signal detection
│   ├── launch/
│   │   └── launchDetector.ts            # WS launch event → LaunchSignal
│   ├── momentum/
│   │   ├── momentumDetector.ts          # Buy count + volume → MomentumSignal
│   │   ├── holderGrowthDetector.ts      # New holder tracking
│   │   └── volumeAccelerationDetector.ts # Volume acceleration
│   └── lifecycle/
│       └── migrationDetector.ts         # Bonding curve → Raydium migration
│
├── risk/                                # Risk guards & controls
│   ├── blacklist/
│   │   ├── creatorBlacklist.ts          # Creator wallet blacklist
│   │   └── tokenBlacklist.ts            # Token blacklist
│   ├── controls/
│   │   ├── emergencyKillSwitch.ts       # Global on/off
│   │   ├── dailyLossGuard.ts            # $40/day loss limit
│   │   ├── cooldownManager.ts           # 5min cooldown after SL
│   │   └── tradeThrottle.ts             # Rate limiting
│   └── exposure/
│       └── maxExposureGuard.ts          # Max 1 concurrent position
│
├── execution/                           # TX infrastructure
│   ├── venues/
│   │   ├── pumpfunVenue.ts              # Pump.fun bonding curve swaps
│   │   └── jupiterVenue.ts              # Jupiter graduated token swaps
│   ├── tx/
│   │   ├── txBuilder.ts                 # Transaction assembly
│   │   ├── txComposer.ts                # Instruction composition
│   │   ├── ataBuilder.ts                # ATA creation (Token-2022 aware)
│   │   └── computeBudgetBuilder.ts      # Priority fees
│   ├── sender/
│   │   ├── sendCoordinator.ts           # Dedup + sign + send
│   │   └── rpcSender.ts                 # Raw RPC send
│   ├── signing/
│   │   └── keypairSigner.ts             # Wallet signing
│   └── lifecycle/
│       └── tradeLifecycleManager.ts     # Position state machine
│
├── adapters/                            # Protocol integration
│   ├── dex/
│   │   ├── jupiterProvider.ts           # Jupiter V6 API
│   │   └── routingProvider.ts           # IRoutingProvider interface
│   └── protocols/pumpfun/
│       ├── shared.ts                    # PDA derivation, borsh helpers
│       ├── tokenParser.ts               # Mint/bonding curve buffer parsing
│       ├── authorityInspector.ts        # Mint/freeze authority check
│       ├── eventDecoder.ts              # Pump.fun log event decoder
│       ├── launchParser.ts              # CREATE instruction parser
│       ├── migrationDetector.ts         # MIGRATION log detector
│       ├── pumpfunTradeBuilder.ts       # BUY/SELL instruction builder
│       ├── officialPumpSdk.ts           # @pump-fun/pump-sdk CJS wrapper
│       └── officialPumpfunQuote.ts      # SDK quote/fee math
│
├── ingestion/                           # Data ingestion
│   ├── wsMessageHandler.ts              # WS message parsing + routing
│   ├── pipeline/
│   │   ├── eventNormalizer.ts           # Raw events → NormalizedEvent
│   │   └── eventDispatcher.ts           # Event routing
│   └── rpc/
│       ├── rpcClient.ts                 # RPC client with failover
│       ├── rpcPool.ts                   # Multi-endpoint pool
│       ├── rpcFailover.ts               # Failover logic
│       └── rateLimiter.ts               # Request rate limiting
│
├── risk/                                # Risk management
│   ├── blacklist/
│   │   ├── creatorBlacklist.ts          # Creator blacklist (in-memory)
│   │   └── tokenBlacklist.ts            # Token blacklist
│   ├── controls/
│   │   ├── emergencyKillSwitch.ts       # Global kill switch
│   │   ├── dailyLossGuard.ts            # Daily P&L tracking
│   │   ├── cooldownManager.ts           # Post-SL cooldown (5 min)
│   │   └── tradeThrottle.ts             # Trade rate limiting
│   └── exposure/
│       └── maxExposureGuard.ts          # Max concurrent positions (1)
│
├── storage/                             # Persistence
│   ├── postgres/
│   │   └── postgresClient.ts            # PostgreSQL pool
│   ├── redis/
│   │   └── redisClient.ts               # Redis client
│   ├── repositories/
│   │   ├── tradeRepository.ts           # Trade CRUD
│   │   └── signalRepository.ts          # Signal CRUD
│   └── backfill/
│       └── pnlBackfill.ts               # On-chain P&L backfill script
│
├── telemetry/                           # Observability
│   ├── logging/
│   │   └── logger.ts                    # Structured logger (pino-style)
│   └── metrics/
│       └── ingestionMetrics.ts          # RPC/event metrics (no-op stubs)
│
└── tests/                               # Test suite (Vitest)
    ├── unit/
    │   ├── strategy/                    # Entry/exit decision tests
    │   ├── risk/                        # Risk guard tests
    │   ├── execution/                   # TX building tests
    │   ├── lifecycle/                   # Migration/lifecycle tests
    │   └── *.test.ts                    # Misc unit tests
    └── integration/
        ├── pipelineIntegrationTest.ts   # Full pipeline harness
        └── pipelineIntegration.test.ts  # Pipeline E2E test
```

## Architecture Layers

| Layer | Directory | Responsibility | External Deps |
|---|---|---|---|
| **Core** | `core/` | Types, constants, interfaces | None |
| **Strategy** | `strategies/` | Business logic (entry/exit) | None (pure) |
| **Detectors** | `detectors/` | Signal detection | None (pure) |
| **Risk** | `risk/` | Risk guards & controls | None (pure) |
| **App** | `app/` | Orchestration, DI, wiring | All layers |
| **Execution** | `execution/` | TX building, sending | Solana |
| **Adapters** | `adapters/` | Protocol integration | Pump.fun, Jupiter |
| **Ingestion** | `ingestion/` | RPC, WebSocket | Solana RPC |
| **Storage** | `storage/` | PostgreSQL, Redis | pg, redis |
| **Telemetry** | `telemetry/` | Logging | pino |

## Data Flow

```
WebSocket → wsMessageHandler → eventDecoder/launchParser
  → launchDetector → LAUNCH signal
  → momentumDetector → MOMENTUM signal
    → strategy.onSignal()
      → dataProvider.getEntryCheckData() [RPC fetch]
      → entryCheckEvaluator [boolean evaluation]
      → evaluateEntry() [9 checks]
        → ALL PASS → riskGuardRunner → buyExecutor → TX → chain
        → ANY FAIL → reject (log reason)

Exit monitoring (2s poll):
  → dataProvider.getPositionData() [RPC fetch]
  → evaluateExit() [TP/SL/timeout]
    → TRIGGER → sellExecutor → TX → chain
```

## Key Files

- **Config source of truth**: `core/constants/defaults.ts`
- **Entry rules**: `strategies/filteredSniper/entryDecision.ts`
- **Exit rules**: `strategies/filteredSniper/exitDecision.ts`
- **Entry check evaluation**: `app/entryCheckEvaluator.ts`
- **Data fetching**: `app/dataProvider.ts`
- **Risk guards**: `app/execution/riskGuardRunner.ts`
- **Bonding curve parsing**: `adapters/protocols/pumpfun/tokenParser.ts`
- **Authority checking**: `adapters/protocols/pumpfun/authorityInspector.ts`
