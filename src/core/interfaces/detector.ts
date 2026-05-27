/**
 * Detector interface contract.
 *
 * Raw event → signal only.
 * NOT: buy decisions, risk logic, DB persistence.
 */

import type { Signal } from '../types/signal.js';

/** Event handler callback */
export type SignalHandler = (signal: Signal) => void;

/** Detector contract — all detectors must implement this */
export interface IDetector {
  /** Detector identifier */
  readonly name: string;

  /** Start detecting events */
  start(): Promise<void>;

  /** Stop detecting events */
  stop(): Promise<void>;

  /** Register a signal handler */
  onSignal(handler: SignalHandler): void;
}
