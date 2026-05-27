/**
 * Event Normalizer — transforms raw blockchain events into a standard internal format.
 * Ingestion layer only: no strategy or business logic.
 */

import { randomUUID } from 'node:crypto';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { recordEventProcessed } from '../../telemetry/metrics/ingestionMetrics.js';

// ── Types ────────────────────────────────────────────────────────────

export type RawEvent = {
  readonly source: string;
  readonly type: string;
  readonly data: unknown;
  readonly receivedAt: number;
  readonly slot: number | null;
};

export type NormalizedEvent = {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly mint: MintAddress | null;
  readonly data: Record<string, unknown>;
  readonly receivedAt: number;
  readonly normalizedAt: number;
  readonly slot: number | null;
};

// ── Normalizer ───────────────────────────────────────────────────────

const MINT_KEYS = ['mint', 'tokenMint', 'tokenAddress'] as const;

export class EventNormalizer {
  /**
   * Normalize a raw blockchain event into the canonical internal format.
   */
  normalize(raw: RawEvent): NormalizedEvent {
    const mint = this.extractMint(raw.data);
    const normalizedData: Record<string, unknown> =
      raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data)
        ? { ...(raw.data as Record<string, unknown>) }
        : { value: raw.data };

    const event: NormalizedEvent = {
      id: randomUUID(),
      source: raw.source,
      type: raw.type,
      mint,
      data: normalizedData,
      receivedAt: raw.receivedAt,
      normalizedAt: nowMs(),
      slot: raw.slot,
    };

    recordEventProcessed(raw.type);

    return event;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Attempt to extract a mint address from the raw data payload by looking
   * for well-known key names.
   */
  private extractMint(data: unknown): MintAddress | null {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const record = data as Record<string, unknown>;

    for (const key of MINT_KEYS) {
      const candidate: unknown = record[key];
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate as MintAddress;
      }
    }

    return null;
  }
}
