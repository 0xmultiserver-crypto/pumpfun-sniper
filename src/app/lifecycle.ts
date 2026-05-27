/**
 * Lifecycle Manager
 *
 * Handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Shutdown sequence:
 *   1. Activate kill switch (prevent new trades)
 *   2. Stop strategy (stop monitoring)
 *   3. Wait for in-flight transactions (with timeout)
 *   4. Close connections (postgres, redis, websockets)
 *   5. Flush telemetry
 *   6. Exit process
 *
 * App layer = orchestration ONLY. No business logic.
 */

import type { ServiceContainer } from './container.js';
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from '../core/constants/timeouts.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('app:lifecycle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shutdown options. */
export interface ShutdownOptions {
  /** Max time to wait for in-flight txs before force-killing (ms). Default: 10_000. */
  readonly gracePeriodMs?: number;
  /** Exit code on clean shutdown. Default: 0. */
  readonly exitCode?: number;
}

// ---------------------------------------------------------------------------
// Lifecycle Manager
// ---------------------------------------------------------------------------

export class LifecycleManager {
  private readonly container: ServiceContainer;
  private shutdownInProgress = false;

  constructor(container: ServiceContainer) {
    this.container = container;
  }

  /**
   * Register signal handlers for graceful shutdown.
   *
   * Handles: SIGINT (Ctrl+C), SIGTERM (kill), uncaughtException, unhandledRejection.
   */
  registerSignalHandlers(): void {
    process.on('SIGINT', () => {
      logger.info('Received SIGINT');
      void this.shutdown({ exitCode: 0 });
    });

    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM');
      void this.shutdown({ exitCode: 0 });
    });

    process.on('uncaughtException', (err: Error) => {
      logger.fatal('Uncaught exception', {
        err: err.message,
        stack: err.stack,
      });
      void this.shutdown({ exitCode: 1 });
    });

    process.on('unhandledRejection', (reason: unknown) => {
      logger.fatal('Unhandled rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      void this.shutdown({ exitCode: 1 });
    });

    logger.info('Signal handlers registered');
  }

  /**
   * Perform graceful shutdown.
   *
   * Idempotent — calling multiple times is safe (second+ calls are no-ops).
   */
  async shutdown(options?: ShutdownOptions): Promise<void> {
    if (this.shutdownInProgress) {
      logger.warn('Shutdown already in progress, ignoring duplicate signal');
      return;
    }

    this.shutdownInProgress = true;
    const gracePeriodMs = options?.gracePeriodMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    const exitCode = options?.exitCode ?? 0;

    logger.info('=== GRACEFUL SHUTDOWN INITIATED ===', {
      gracePeriodMs,
      exitCode,
    });

    const shutdownStart = Date.now();

    try {
      // Step 1: Activate kill switch
      logger.info('Step 1/5: Activating kill switch...');
      this.container.killSwitch.kill('Graceful shutdown initiated', 'lifecycle');
      logger.info('  Kill switch activated — no new trades will be opened');

      // Step 2: Stop strategy
      logger.info('Step 2/5: Stopping strategy...');
      try {
        this.container.strategy.stop();
        logger.info('  Strategy stopped');
      } catch {
        // strategy getter throws if not wired via setStrategy() — expected during early shutdown
        logger.info('  Strategy not wired yet, skipping');
      }

      // Step 3: Wait for in-flight transactions
      logger.info('Step 3/5: Waiting for in-flight transactions...');
      const activeCount = this.container.tradeLifecycleManager.activeTradeCount;
      if (activeCount > 0) {
        logger.info(`  ${activeCount} active trade(s), waiting up to ${gracePeriodMs}ms...`);
        await this.waitForInflight(gracePeriodMs);
      } else {
        logger.info('  No active trades');
      }

      // Step 4: Close connections
      logger.info('Step 4/5: Closing connections...');
      await this.container.destroy();
      logger.info('  All connections closed');

      // Step 5: Final log
      const elapsed = Date.now() - shutdownStart;
      logger.info('Step 5/5: Shutdown complete', { shutdownTimeMs: elapsed });
      logger.info('=== PUMPFUN SNIPER SHUT DOWN CLEANLY ===');
    } catch (err: unknown) {
      logger.error('Error during shutdown', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Give logger time to flush
      setTimeout(() => {
        process.exit(exitCode);
      }, 500);
    }
  }

  /**
   * Wait for in-flight transactions to complete (with timeout).
   */
  private async waitForInflight(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollMs = 1_000;

    while (Date.now() < deadline) {
      const activeCount = this.container.tradeLifecycleManager.activeTradeCount;
      if (activeCount === 0) {
        logger.info('  All in-flight transactions completed');
        return;
      }

      logger.debug(`  Still ${activeCount} active trade(s), waiting...`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const remaining = this.container.tradeLifecycleManager.activeTradeCount;
    if (remaining > 0) {
      logger.warn(`  Grace period expired with ${remaining} active trade(s) — force closing`);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: setup and run
// ---------------------------------------------------------------------------

/**
 * Wire lifecycle manager to a container and register signal handlers.
 */
export function setupLifecycle(container: ServiceContainer): LifecycleManager {
  const lifecycle = new LifecycleManager(container);
  lifecycle.registerSignalHandlers();
  return lifecycle;
}
