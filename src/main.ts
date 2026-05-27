/**
 * main.ts — Application Entry Point
 *
 * This is THE entry point. Run with:
 *   Development:  npm run dev        (tsx src/main.ts)
 *   Production:   npm run build && node dist/main.js
 *
 * Startup flow:
 *   1. bootstrap() → ServiceContainer (config, infra, RPC)
 *   2. Wire strategy (FilteredSniperStrategy with data + execution providers)
 *   3. Register signal handlers (graceful shutdown)
 *   4. Connect WebSocket to Helius
 *   5. Subscribe to Pump.fun program logs
 *   6. Enter event loop: parse → detect → filter → decide → execute
 *
 * This file = orchestration ONLY. All business logic lives in the
 * respective layers (detectors, heuristics, strategy, execution).
 */

import { bootstrap } from './app/bootstrap.js';
import { setupLifecycle } from './app/lifecycle.js';
import { createDataProvider } from './app/dataProvider.js';
import { createExecutionDelegate } from './app/executionDelegate.js';
import { FilteredSniperStrategy } from './strategies/filteredSniper/filteredSniperStrategy.js';
import { PositionRegistry } from './core/state/positionRegistry.js';
import { LaunchDetector } from './detectors/launch/launchDetector.js';
import { MomentumDetector } from './detectors/momentum/momentumDetector.js';
import { MigrationSignalDetector } from './detectors/lifecycle/migrationDetector.js';
import { EventDispatcher } from './ingestion/pipeline/eventDispatcher.js';
import { EventNormalizer } from './ingestion/pipeline/eventNormalizer.js';
import type { PositionProvider } from './risk/exposure/maxExposureGuard.js';
import { createLogger } from './telemetry/logging/logger.js';
import { PUMPFUN_PROGRAM_ID } from './core/constants/programs.js';
import { nowMs } from './core/utils/time.js';
import { generateId } from './core/utils/serialization.js';
import { WsManager } from './app/wsManager.js';
import { restoreOpenPositionsFromDb, hasLiveTokenBalance } from './app/positionRecovery.js';
import { handleWsMessage } from './ingestion/wsMessageHandler.js';
import type { TradeRecord } from './core/types/trade.js';
import {
  MOMENTUM_MIN_BUYS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
  MOMENTUM_WINDOW_SECONDS,
} from './strategies/filteredSniper/filteredSniperRules.js';
import { PublicKey } from '@solana/web3.js';

const logger = createLogger('main');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║       PUMPFUN SNIPER — STARTING          ║');
  logger.info('╚══════════════════════════════════════════╝');

  // Step 1: Bootstrap (config + container + infra)
  const container = await bootstrap();

  // Step 2: Wire strategy with data + execution providers
  logger.info('Wiring strategy...');
  const positionRegistry = new PositionRegistry();
  const dataProvider = createDataProvider(container, positionRegistry);
  const executionDelegate = createExecutionDelegate(container, positionRegistry);
  const strategy = new FilteredSniperStrategy(dataProvider, executionDelegate);
  container.setStrategy(strategy);
  const walletPublicKey = container.signer.getPublicKey();
  const recoveryResult = await restoreOpenPositionsFromDb({
    tradeRepository: container.tradeRepository,
    positionRegistry,
    monitorTrade: (tradeId) => strategy.monitorTrade(tradeId),
    hasTokenBalance: (trade: TradeRecord) => hasLiveTokenBalance(container.connection, walletPublicKey, new PublicKey(trade.mint)),
  });
  logger.info('DB open-position recovery complete', {
    restored: recoveryResult.restored,
    skipped: recoveryResult.skipped,
  });
  logger.info('FilteredSniperStrategy wired');

  // Wire Risk Guards
  container.dailyLossGuard.onKill((state) => {
    container.killSwitch.kill(
      `Daily loss limit breached: $${state.dailyPnlUsd.toFixed(2)}`,
      'daily-loss-guard',
    );
  });

  const positionProvider: PositionProvider = {
    getOpenPositionCount: async () => positionRegistry.getActiveCount(),
    getTotalExposureLamports: async () => {
      let total = 0n;
      for (const pos of positionRegistry.getActive()) {
        total += pos.entryPriceSol ?? 0n;
      }
      return total;
    },
  };
  container.setMaxExposurePositionProvider(positionProvider);
  logger.info('Risk guards wired (kill switch, daily loss, cooldown, throttle, exposure)');

  // Restore risk state from DB (survives restarts)
  await Promise.all([
    container.dailyLossGuard.restore(),
    container.cooldownManager.restore(),
    container.creatorBlacklist.restore(),
  ]);
  logger.info('Risk state restored from DB');

  // Step 3: Register signal handlers (graceful shutdown)
  setupLifecycle(container);
  logger.info('Lifecycle handlers registered');

  // Step 4: Initialize detection pipeline
  logger.info('Initializing detection pipeline...');
  const normalizer = new EventNormalizer();
  const dispatcher = new EventDispatcher();
  const launchDetector = new LaunchDetector();
  const momentumDetector = new MomentumDetector({
    windowSeconds: MOMENTUM_WINDOW_SECONDS,
    minBuyCount: MOMENTUM_MIN_BUYS,
    minVolumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
  });
  const migrationDetector = new MigrationSignalDetector();

  // Wire detector signal handlers → strategy.onSignal() + save to DB
  launchDetector.onSignal((signal) => {
    logger.info('Launch signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').LaunchSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'LAUNCH' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, creator: s.creator ?? '', signature: s.signature ?? '',
    }).catch(() => {});
    strategy.onSignal(signal).catch((err: unknown) => {
      logger.error('Launch signal processing failed', {
        mint: signal.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  momentumDetector.onSignal((signal) => {
    logger.info('Momentum signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').MomentumSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'MOMENTUM' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, buyCount: s.buyCount ?? 0,
      windowSeconds: s.windowSeconds ?? MOMENTUM_WINDOW_SECONDS, volumeSol: s.volumeSol ?? 0n,
    }).catch(() => {});
    strategy.onSignal(signal).catch((err: unknown) => {
      logger.error('Momentum signal processing failed', {
        mint: signal.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  migrationDetector.onSignal((signal) => {
    logger.info('Migration signal detected', { mint: signal.mint });
    const s = signal as import('./core/types/signal.js').MigrationSignal;
    void container.signalRepository.save({
      id: generateId('sig'), type: 'MIGRATION' as const, mint: s.mint,
      timestamp: nowMs(), slot: s.slot ?? 0, migrationSignature: s.migrationSignature ?? '',
    }).catch(() => {});
  });

  // Register event dispatcher handlers → feed events to detectors
  dispatcher.on('launch', (event) => {
    launchDetector.handleLaunchEvent({
      mint: event.mint ?? '', creator: (event.data['creator'] as string) ?? '',
      name: (event.data['name'] as string) ?? '', symbol: (event.data['symbol'] as string) ?? '',
      uri: (event.data['uri'] as string) ?? '', slot: event.slot ?? 0,
      signature: (event.data['signature'] as string) ?? '', timestamp: event.receivedAt,
    });
  });

  dispatcher.on('trade', (event) => {
    const isBuy = (event.data['isBuy'] as boolean) ?? true;
    momentumDetector.handleTrade({
      mint: event.mint ?? '', isBuy,
      solAmount: typeof event.data['solAmount'] === 'bigint' ? event.data['solAmount'] as bigint : BigInt((event.data['solAmount'] as string) ?? '0'),
      slot: event.slot ?? 0, timestamp: event.receivedAt,
      wallet: (event.data[isBuy ? 'buyer' : 'seller'] as string) ?? undefined,
    });
  });

  dispatcher.on('migration', (event) => {
    migrationDetector.handleTransaction({
      mint: event.mint ?? '', logs: (event.data['logs'] as readonly string[]) ?? [],
      slot: event.slot ?? 0, signature: (event.data['signature'] as string) ?? '',
    });
  });

  logger.info('Detection pipeline ready (launch + momentum + migration)');
  await launchDetector.start();
  await momentumDetector.start();
  await migrationDetector.start();

  // Step 5: Start strategy before opening WebSocket so early signals are not ignored.
  strategy.start();

  // Step 6: Connect WebSocket (using WsManager with auto-reconnect)
  logger.info('Connecting to Helius WebSocket...');
  const wsUrl = container.wsUrl;

  const wsManager = new WsManager({
    url: wsUrl,
    onOpen: () => {
      logger.info('Subscribing to pump.fun program logs...');
      wsManager.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMPFUN_PROGRAM_ID.toBase58()] }, { commitment: 'confirmed' }],
      }));
      logger.info('Subscription sent');
    },
    onMessage: (raw: Buffer) => {
      handleWsMessage(raw.toString(), normalizer, dispatcher);
    },
    onFatal: () => {
      logger.fatal('WebSocket connection lost permanently — shutting down');
      process.exit(1);
    },
  });

  await wsManager.connect();

  // Step 7: Strategy is already running before the WebSocket connection opens.

  const walletPubkey = container.signer.getPublicKey().toBase58();
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║       PUMPFUN SNIPER — LIVE              ║');
  logger.info('╚══════════════════════════════════════════╝');
  logger.info('Bot is now listening for new token launches', {
    wallet: walletPubkey, strategy: 'FilteredSniper',
    entryVenue: 'Pump.fun', exitVenues: 'Pump.fun (bonding) / Jupiter (graduated)', mode: 'LIVE',
  });

  // Keep alive — process stays running via WebSocket connection
  await new Promise<void>(() => {
    // Never resolves — process stays alive until signal received
    // LifecycleManager.shutdown() will call process.exit()
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.fatal('Fatal error in main', {
    error: msg,
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
