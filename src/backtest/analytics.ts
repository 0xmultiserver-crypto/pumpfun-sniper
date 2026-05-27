/**
 * Analytics — calculates backtest performance metrics from simulated trades.
 *
 * Metrics:
 *   - PnL curve (time series)
 *   - Win rate (profitable trades / total trades)
 *   - Max drawdown (peak-to-trough)
 *   - Sharpe ratio (annualized, assuming 365 trading days)
 *   - Total PnL in SOL and USD
 *   - Average trade duration
 *   - Best/worst trade
 */

import type { SimulatedTrade } from './replayEngine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PnLPoint {
  readonly timestamp: number;
  readonly cumulativePnlUsd: number;
  readonly cumulativePnlSol: number;
}

export interface TradeSummary {
  readonly mint: string;
  readonly pnlUsd: number;
  readonly pnlPercent: number;
  readonly durationMs: number;
  readonly exitReason: string;
}

export interface BacktestAnalytics {
  /** Time series of cumulative PnL. */
  readonly pnlCurve: readonly PnLPoint[];
  /** Total PnL in SOL. */
  readonly totalPnlSol: number;
  /** Total PnL in USD. */
  readonly totalPnlUsd: number;
  /** Win rate: profitable trades / total trades (0-1). */
  readonly winRate: number;
  /** Maximum drawdown in USD (positive number = loss). */
  readonly maxDrawdownUsd: number;
  /** Maximum drawdown as percentage from peak. */
  readonly maxDrawdownPct: number;
  /** Annualized Sharpe ratio (365 trading days, daily returns). */
  readonly sharpeRatio: number;
  /** Total number of trades. */
  readonly totalTrades: number;
  /** Number of winning trades. */
  readonly winningTrades: number;
  /** Number of losing trades. */
  readonly losingTrades: number;
  /** Average trade duration in milliseconds. */
  readonly avgTradeDurationMs: number;
  /** Best trade (highest PnL). */
  readonly bestTrade: TradeSummary | null;
  /** Worst trade (lowest PnL). */
  readonly worstTrade: TradeSummary | null;
  /** Breakdown by exit reason. */
  readonly exitReasonBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Analytics calculator
// ---------------------------------------------------------------------------

export function calculateAnalytics(trades: readonly SimulatedTrade[]): BacktestAnalytics {
  if (trades.length === 0) {
    return {
      pnlCurve: [],
      totalPnlSol: 0,
      totalPnlUsd: 0,
      winRate: 0,
      maxDrawdownUsd: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      avgTradeDurationMs: 0,
      bestTrade: null,
      worstTrade: null,
      exitReasonBreakdown: {},
    };
  }

  // Sort trades by exit timestamp for PnL curve
  const sorted = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);

  // --- PnL curve ---
  const pnlCurve: PnLPoint[] = [];
  let cumulativePnlUsd = 0;
  let cumulativePnlSol = 0;

  for (const trade of sorted) {
    cumulativePnlUsd += trade.pnlUsd;
    cumulativePnlSol += trade.pnlSol;
    pnlCurve.push({
      timestamp: trade.exitTimestamp,
      cumulativePnlUsd,
      cumulativePnlSol,
    });
  }

  // --- Totals ---
  const totalPnlUsd = cumulativePnlUsd;
  const totalPnlSol = cumulativePnlSol;

  // --- Win rate ---
  let winningTrades = 0;
  let losingTrades = 0;

  for (const trade of sorted) {
    if (trade.pnlUsd > 0) {
      winningTrades++;
    } else if (trade.pnlUsd < 0) {
      losingTrades++;
    }
  }

  const winRate = sorted.length > 0 ? winningTrades / sorted.length : 0;

  // --- Max drawdown ---
  let peakPnlUsd = 0;
  let maxDrawdownUsd = 0;

  for (const point of pnlCurve) {
    if (point.cumulativePnlUsd > peakPnlUsd) {
      peakPnlUsd = point.cumulativePnlUsd;
    }
    const drawdown = peakPnlUsd - point.cumulativePnlUsd;
    if (drawdown > maxDrawdownUsd) {
      maxDrawdownUsd = drawdown;
    }
  }

  const maxDrawdownPct = peakPnlUsd > 0 ? (maxDrawdownUsd / peakPnlUsd) * 100 : 0;

  // --- Sharpe ratio (annualized) ---
  // Group trades by day to compute daily returns
  const dailyReturns = new Map<string, number>();

  for (const trade of sorted) {
    const dayKey = new Date(trade.exitTimestamp).toISOString().slice(0, 10);
    const existing = dailyReturns.get(dayKey) ?? 0;
    dailyReturns.set(dayKey, existing + trade.pnlUsd);
  }

  const returns = Array.from(dailyReturns.values());
  const avgReturn = returns.length > 0
    ? returns.reduce((sum, r) => sum + r, 0) / returns.length
    : 0;

  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1)
    : 0;

  const stdDev = Math.sqrt(variance);

  // Annualized Sharpe = (mean daily return / std daily return) * sqrt(365)
  // Risk-free rate omitted for simplicity (crypto has no risk-free rate)
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0;

  // --- Average trade duration ---
  const totalDurationMs = sorted.reduce((sum, t) => sum + t.durationMs, 0);
  const avgTradeDurationMs = totalDurationMs / sorted.length;

  // --- Best/worst trade ---
  let bestTradeIdx = 0;
  let worstTradeIdx = 0;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.pnlUsd > sorted[bestTradeIdx]!.pnlUsd) bestTradeIdx = i;
    if (sorted[i]!.pnlUsd < sorted[worstTradeIdx]!.pnlUsd) worstTradeIdx = i;
  }

  const toSummary = (trade: SimulatedTrade): TradeSummary => ({
    mint: trade.mint,
    pnlUsd: trade.pnlUsd,
    pnlPercent: trade.pnlPercent,
    durationMs: trade.durationMs,
    exitReason: trade.exitReason,
  });

  const bestTrade = toSummary(sorted[bestTradeIdx]!);
  const worstTrade = toSummary(sorted[worstTradeIdx]!);

  // --- Exit reason breakdown ---
  const exitReasonBreakdown: Record<string, number> = {};
  for (const trade of sorted) {
    exitReasonBreakdown[trade.exitReason] = (exitReasonBreakdown[trade.exitReason] ?? 0) + 1;
  }

  return {
    pnlCurve,
    totalPnlSol,
    totalPnlUsd,
    winRate,
    maxDrawdownUsd,
    maxDrawdownPct,
    sharpeRatio,
    totalTrades: sorted.length,
    winningTrades,
    losingTrades,
    avgTradeDurationMs,
    bestTrade,
    worstTrade,
    exitReasonBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatSol(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)} SOL`;
}

/** Format analytics as a human-readable text report. */
export function formatReport(
  analytics: BacktestAnalytics,
  from: string,
  to: string,
  params: { windowSeconds: number; minBuyCount: number; positionSizeUsd: number; stopLossPct: number; takeProfitPct: number },
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('                    PUMPFUN SNIPER — BACKTEST REPORT');
  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Period:             ${from}  →  ${to}`);
  lines.push(`  Window Seconds:     ${params.windowSeconds}s`);
  lines.push(`  Min Buy Count:      ${params.minBuyCount}`);
  lines.push(`  Position Size:      $${params.positionSizeUsd.toFixed(2)}`);
  lines.push(`  Stop Loss:          -${params.stopLossPct}%`);
  lines.push(`  Take Profit:        +${params.takeProfitPct}%`);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────────');
  lines.push('  PERFORMANCE SUMMARY');
  lines.push('────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Total PnL (USD):    ${formatUsd(analytics.totalPnlUsd)}`);
  lines.push(`  Total PnL (SOL):    ${formatSol(analytics.totalPnlSol)}`);
  lines.push(`  Win Rate:            ${(analytics.winRate * 100).toFixed(1)}%`);
  lines.push(`  Sharpe Ratio:        ${analytics.sharpeRatio.toFixed(2)}`);
  lines.push(`  Max Drawdown:        ${formatUsd(-analytics.maxDrawdownUsd)} (${analytics.maxDrawdownPct.toFixed(1)}%)`);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────────');
  lines.push('  TRADE STATISTICS');
  lines.push('────────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Total Trades:        ${analytics.totalTrades}`);
  lines.push(`  Winning Trades:      ${analytics.winningTrades}`);
  lines.push(`  Losing Trades:       ${analytics.losingTrades}`);
  lines.push(`  Avg Duration:        ${formatDuration(analytics.avgTradeDurationMs)}`);
  lines.push('');

  if (analytics.bestTrade !== null) {
    lines.push(`  Best Trade:          ${analytics.bestTrade.mint.slice(0, 12)}...`);
    lines.push(`                       ${formatUsd(analytics.bestTrade.pnlUsd)} (${analytics.bestTrade.pnlPercent.toFixed(1)}%)`);
    lines.push(`                       Duration: ${formatDuration(analytics.bestTrade.durationMs)}`);
    lines.push(`                       Exit: ${analytics.bestTrade.exitReason}`);
  }

  if (analytics.worstTrade !== null) {
    lines.push('');
    lines.push(`  Worst Trade:         ${analytics.worstTrade.mint.slice(0, 12)}...`);
    lines.push(`                       ${formatUsd(analytics.worstTrade.pnlUsd)} (${analytics.worstTrade.pnlPercent.toFixed(1)}%)`);
    lines.push(`                       Duration: ${formatDuration(analytics.worstTrade.durationMs)}`);
    lines.push(`                       Exit: ${analytics.worstTrade.exitReason}`);
  }

  lines.push('');

  if (Object.keys(analytics.exitReasonBreakdown).length > 0) {
    lines.push('────────────────────────────────────────────────────────────────────');
    lines.push('  EXIT REASON BREAKDOWN');
    lines.push('────────────────────────────────────────────────────────────────────');
    lines.push('');
    for (const [reason, count] of Object.entries(analytics.exitReasonBreakdown)) {
      const pct = analytics.totalTrades > 0 ? ((count / analytics.totalTrades) * 100).toFixed(1) : '0.0';
      lines.push(`  ${reason.padEnd(20)} ${count} (${pct}%)`);
    }
    lines.push('');
  }

  // Mini PnL curve (ASCII sparkline)
  if (analytics.pnlCurve.length > 1) {
    lines.push('────────────────────────────────────────────────────────────────────');
    lines.push('  PnL CURVE (USD)');
    lines.push('────────────────────────────────────────────────────────────────────');
    lines.push('');

    const maxPoints = 50;
    const curve = analytics.pnlCurve;
    const step = Math.max(1, Math.floor(curve.length / maxPoints));
    const sampled: PnLPoint[] = [];
    for (let i = 0; i < curve.length; i += step) {
      sampled.push(curve[i]!);
    }
    // Always include last point
    if (sampled[sampled.length - 1] !== curve[curve.length - 1]) {
      sampled.push(curve[curve.length - 1]!);
    }

    const values = sampled.map((p) => p.cumulativePnlUsd);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;
    const height = 10;

    for (let row = height; row >= 0; row--) {
      const threshold = minVal + (range * row) / height;
      const label = row === height ? formatUsd(maxVal).padStart(12) :
                    row === 0 ? formatUsd(minVal).padStart(12) :
                    '            ';
      const bar = values
        .map((v) => (v >= threshold ? '█' : ' '))
        .join('');
      lines.push(`  ${label} │${bar}`);
    }

    lines.push(`             └${'─'.repeat(sampled.length)}`);
    lines.push('');
  }

  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}
