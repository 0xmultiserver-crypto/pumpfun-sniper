/**
 * Telemetry type definitions.
 *
 * Structured logging and metrics types. No side effects.
 */

import type { MintAddress } from './token.js';

/** Log severity levels */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Structured log entry */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly context: Record<string, unknown>;
  readonly module: string;
}

/** Metric type discriminator */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Metric data point */
export interface MetricPoint {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly labels: Record<string, string>;
  readonly timestamp: number;
}

/** Latency tracking for critical paths */
export interface LatencyMetric {
  readonly operation: string;
  readonly mint: MintAddress | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}
