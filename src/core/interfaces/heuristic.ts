/**
 * Heuristic interface contract.
 *
 * Decision intelligence: scam checks, scoring, validation.
 * NOT: execution, DB writes, network calls (unless explicitly needed).
 */

import type { MintAddress } from '../types/token.js';

/** Heuristic check result */
export interface HeuristicResult {
  readonly passed: boolean;
  readonly checkName: string;
  readonly reason: string | null;
  readonly score: number | null;
  readonly checkedAt: number;
}

/** Heuristic check contract */
export interface IHeuristic {
  /** Check identifier */
  readonly name: string;

  /** Run the heuristic check against a token */
  check(mint: MintAddress): Promise<HeuristicResult>;
}
