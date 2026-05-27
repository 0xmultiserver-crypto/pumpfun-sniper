/**
 * Backtest CLI — entry point for running backtests from the command line.
 *
 * Usage:
 *   npx tsx src/backtest/cli.ts --from=2026-05-01 --to=2026-05-27
 *
 * Optional params:
 *   --window-seconds=N   Momentum window (default: 15)
 *   --min-buys=N         Min buys in window (default: 7)
 *   --position-size-usd=N  Position size in USD (default: 1)
 *   --stop-loss-pct=N    Stop loss % (default: 50)
 *   --take-profit-pct=N  Take profit % (default: 500)
 */

import { Pool } from 'pg';
import { EventRecorder } from './eventRecorder.js';
import { ReplayEngine, DEFAULT_REPLAY_PARAMETERS } from './replayEngine.js';
import { calculateAnalytics, formatReport } from './analytics.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('backtest:cli');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly from: string;
  readonly to: string;
  readonly windowSeconds: number;
  readonly minBuys: number;
  readonly positionSizeUsd: number;
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (const arg of args) {
    const match = arg.match(/^--([\w-]+)=(.+)$/);
    if (match !== null) {
      parsed[match[1]!] = match[2]!;
    }
  }

  const from = parsed['from'];
  const to = parsed['to'];

  if (from === undefined || to === undefined) {
    console.error('Usage: npx tsx src/backtest/cli.ts --from=YYYY-MM-DD --to=YYYY-MM-DD');
    console.error('');
    console.error('Required:');
    console.error('  --from=YYYY-MM-DD    Start date (inclusive)');
    console.error('  --to=YYYY-MM-DD      End date (inclusive)');
    console.error('');
    console.error('Optional:');
    console.error('  --window-seconds=N   Momentum window seconds (default: 15)');
    console.error('  --min-buys=N         Min buys in window (default: 7)');
    console.error('  --position-size-usd=N  Position size USD (default: 1)');
    console.error('  --stop-loss-pct=N    Stop loss % (default: 50)');
    console.error('  --take-profit-pct=N  Take profit % (default: 500)');
    process.exit(1);
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error('Error: dates must be in YYYY-MM-DD format');
    process.exit(1);
  }

  return {
    from,
    to,
    windowSeconds: parsed['window-seconds'] !== undefined
      ? parseInt(parsed['window-seconds'], 10)
      : DEFAULT_REPLAY_PARAMETERS.windowSeconds,
    minBuys: parsed['min-buys'] !== undefined
      ? parseInt(parsed['min-buys'], 10)
      : DEFAULT_REPLAY_PARAMETERS.minBuyCount,
    positionSizeUsd: parsed['position-size-usd'] !== undefined
      ? parseFloat(parsed['position-size-usd'])
      : DEFAULT_REPLAY_PARAMETERS.positionSizeUsd,
    stopLossPct: parsed['stop-loss-pct'] !== undefined
      ? parseFloat(parsed['stop-loss-pct'])
      : DEFAULT_REPLAY_PARAMETERS.stopLossPct,
    takeProfitPct: parsed['take-profit-pct'] !== undefined
      ? parseFloat(parsed['take-profit-pct'])
      : DEFAULT_REPLAY_PARAMETERS.takeProfitPct,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // Convert dates to timestamp range (milliseconds)
  const fromDate = new Date(`${args.from}T00:00:00.000Z`);
  const toDate = new Date(`${args.to}T23:59:59.999Z`);
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();

  logger.info('Starting backtest', {
    from: args.from,
    to: args.to,
    windowSeconds: args.windowSeconds,
    minBuys: args.minBuys,
    positionSizeUsd: args.positionSizeUsd,
    stopLossPct: args.stopLossPct,
    takeProfitPct: args.takeProfitPct,
  });

  // Connect to PostgreSQL
  const connectionString = process.env['POSTGRES_URL'] ?? 'postgresql://localhost:5432/pumpfun';
  const pool = new Pool({ connectionString, max: 5 });

  try {
    const recorder = new EventRecorder(pool);
    await recorder.start();

    // Fetch events
    console.log(`Fetching events from ${args.from} to ${args.to}...`);
    const eventCount = await recorder.getEventCount(fromMs, toMs);
    console.log(`Found ${eventCount} events`);

    if (eventCount === 0) {
      console.log('No events found in the specified date range.');
      console.log('Make sure the bot is running with EventRecorder wired in to collect events.');
      await pool.end();
      return;
    }

    const events = await recorder.getEvents(fromMs, toMs);
    console.log(`Loaded ${events.length} events for replay`);

    // Run replay
    console.log('Running replay...');
    const replayEngine = new ReplayEngine({
      windowSeconds: args.windowSeconds,
      minBuyCount: args.minBuys,
      positionSizeUsd: args.positionSizeUsd,
      stopLossPct: args.stopLossPct,
      takeProfitPct: args.takeProfitPct,
    });

    const result = replayEngine.replay(events);

    // Calculate analytics
    const analytics = calculateAnalytics(result.trades);

    // Print report
    const report = formatReport(analytics, args.from, args.to, {
      windowSeconds: args.windowSeconds,
      minBuyCount: args.minBuys,
      positionSizeUsd: args.positionSizeUsd,
      stopLossPct: args.stopLossPct,
      takeProfitPct: args.takeProfitPct,
    });

    console.log(report);

    // Print signal stats
    console.log(`  Events Processed:    ${result.eventsProcessed}`);
    console.log(`  Momentum Signals:    ${result.momentumSignals}`);
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  if (err instanceof Error && err.stack !== undefined) {
    console.error(err.stack);
  }
  process.exit(1);
});
