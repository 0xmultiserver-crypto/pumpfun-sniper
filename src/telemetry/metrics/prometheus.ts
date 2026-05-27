/**
 * Prometheus Metrics
 *
 * Centralised metrics registry for the PumpFun sniper bot.
 * Exposes counters, gauges, and histograms for key pipeline events.
 *
 * Design:
 *   - Single Registry (no default global collisions)
 *   - Default process/runtime metrics via collectDefaultMetrics
 *   - Custom business metrics with helper increment functions
 *   - getMetrics() returns Prometheus text format for scraping
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const register = new Registry();

collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

/** Events decoded from the WebSocket stream. */
export const eventsTotal = new Counter({
  name: 'pumpfun_events_total',
  help: 'Total events decoded from the WS stream',
  labelNames: ['type'] as const,
  registers: [register],
});

/** Signals emitted by detectors. */
export const signalsTotal = new Counter({
  name: 'pumpfun_signals_total',
  help: 'Total signals emitted by detection pipeline',
  labelNames: ['type', 'outcome'] as const,
  registers: [register],
});

/** Trades executed (buy/sell). */
export const tradesTotal = new Counter({
  name: 'pumpfun_trades_total',
  help: 'Total trades executed',
  labelNames: ['direction', 'outcome'] as const,
  registers: [register],
});

/** P&L distribution in USD per trade. */
export const pnlUsd = new Histogram({
  name: 'pumpfun_pnl_usd',
  help: 'Realised P&L per trade in USD',
  buckets: [-50, -20, -10, -5, 0, 5, 10, 20, 50, 100, 500],
  registers: [register],
});

/** Number of currently active positions. */
export const positionsActive = new Gauge({
  name: 'pumpfun_positions_active',
  help: 'Number of currently active positions',
  registers: [register],
});

/** Bundle/sandwich detections. */
export const bundleDetectionsTotal = new Counter({
  name: 'pumpfun_bundle_detections_total',
  help: 'Total bundle/sandwich detections',
  registers: [register],
});

/** Risk guard blocks. */
export const riskBlocksTotal = new Counter({
  name: 'pumpfun_risk_blocks_total',
  help: 'Total risk guard blocks',
  labelNames: ['reason'] as const,
  registers: [register],
});

/** Exit triggers. */
export const exitTriggersTotal = new Counter({
  name: 'pumpfun_exit_triggers_total',
  help: 'Total exit triggers by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

/** WebSocket reconnects. */
export const wsReconnectsTotal = new Counter({
  name: 'pumpfun_ws_reconnects_total',
  help: 'Total WebSocket reconnect attempts',
  registers: [register],
});

/** Current SOL price. */
export const solPriceUsd = new Gauge({
  name: 'pumpfun_sol_price_usd',
  help: 'Current SOL/USD price',
  registers: [register],
});

/** Rent reclaimed from closed token accounts. */
export const rentReclaimedLamports = new Counter({
  name: 'pumpfun_rent_reclaimed_lamports',
  help: 'Total lamports reclaimed from closed token accounts',
  registers: [register],
});

/** Number of token accounts closed for rent reclaim. */
export const rentReclaimCount = new Counter({
  name: 'pumpfun_rent_reclaim_count',
  help: 'Total token accounts closed for rent reclaim',
  registers: [register],
});

/** Jito bundles submitted. */
export const jitoBundlesTotal = new Counter({
  name: 'pumpfun_jito_bundles_total',
  help: 'Total Jito bundle submissions attempted',
  registers: [register],
});

/** Jito bundle failures. */
export const jitoFailuresTotal = new Counter({
  name: 'pumpfun_jito_failures_total',
  help: 'Total Jito bundle submission failures',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Increment helpers
// ---------------------------------------------------------------------------

/** Record a decoded event. */
export function recordEvent(type: 'BUY' | 'SELL' | 'CREATE'): void {
  eventsTotal.inc({ type });
}

/** Record a signal emission. */
export function recordSignal(
  type: 'MOMENTUM' | 'LAUNCH' | 'MIGRATION',
  outcome: 'accepted' | 'rejected',
): void {
  signalsTotal.inc({ type, outcome });
}

/** Record an executed trade. */
export function recordTrade(direction: 'BUY' | 'SELL', outcome: 'success' | 'failed'): void {
  tradesTotal.inc({ direction, outcome });
}

/** Observe a P&L value in USD. */
export function recordPnl(usdValue: number): void {
  pnlUsd.observe(usdValue);
}

/** Set the active position count. */
export function setActivePositions(count: number): void {
  positionsActive.set(count);
}

/** Increment the active position count. */
export function incActivePositions(): void {
  positionsActive.inc();
}

/** Decrement the active position count. */
export function decActivePositions(): void {
  positionsActive.dec();
}

/** Record a bundle detection. */
export function recordBundleDetection(): void {
  bundleDetectionsTotal.inc();
}

/** Record a risk guard block. */
export function recordRiskBlock(
  reason: 'kill_switch' | 'cooldown' | 'throttle' | 'daily_loss' | 'max_exposure',
): void {
  riskBlocksTotal.inc({ reason });
}

/** Record an exit trigger. */
export function recordExitTrigger(
  reason: 'TP' | 'SL' | 'TRAILING' | 'TIMEOUT' | 'GRADUATED' | 'SCALE_OUT' | 'ANTI_RUG',
): void {
  exitTriggersTotal.inc({ reason });
}

/** Record a WebSocket reconnect. */
export function recordWsReconnect(): void {
  wsReconnectsTotal.inc();
}

/** Set the current SOL/USD price gauge. */
export function setSolPrice(price: number): void {
  solPriceUsd.set(price);
}

/** Record a rent reclaim. */
export function recordRentReclaim(lamports: bigint): void {
  rentReclaimedLamports.inc(Number(lamports));
  rentReclaimCount.inc();
}

// ---------------------------------------------------------------------------
// Metrics output
// ---------------------------------------------------------------------------

/**
 * Get all metrics in Prometheus text format.
 * Returns a plain-text string suitable for the /metrics HTTP endpoint.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get the content type for Prometheus metrics.
 */
export function getContentType(): string {
  return register.contentType;
}
