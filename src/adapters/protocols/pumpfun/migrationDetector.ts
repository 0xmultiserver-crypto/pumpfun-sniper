/**
 * Pump.fun Migration Detector
 *
 * Detects when a Pump.fun token has graduated (migrated to Raydium).
 * Uses bonding curve state and transaction log analysis.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import { PublicKey } from '@solana/web3.js';

import type { MintAddress } from '../../../core/types/token.js';
import { deriveBondingCurvePDA } from './shared.js';
import type { RpcClient } from '../../../ingestion/rpc/rpcClient.js';
import { createLogger } from '../../../telemetry/logging/logger.js';
import { nowMs } from '../../../core/utils/time.js';
import { parseBondingCurveData } from './tokenParser.js';

const logger = createLogger('pumpfun:migrationDetector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationStatus = 'BONDING' | 'GRADUATED' | 'UNKNOWN';

export interface MigrationInfo {
  readonly mint: MintAddress;
  readonly status: MigrationStatus;
  readonly detectedAt: number;
  readonly slot: number | null;
  readonly signature: string | null;
}

// ---------------------------------------------------------------------------
// PDA derivation — same as pumpfunAdapter/pumpfunTradeBuilder
// ---------------------------------------------------------------------------

/**
 * Derive the Pump.fun bonding curve PDA for a given mint.
 *
 * Seeds: ["bonding-curve", mint_pubkey]
 * Program: PUMPFUN_PROGRAM_ID
 */
// deriveBondingCurvePDA imported from ./shared.ts — single source of truth

// ---------------------------------------------------------------------------
// Log-based detection
// ---------------------------------------------------------------------------

/** Patterns in Pump.fun program logs that indicate a migration event. */
const MIGRATION_LOG_PATTERNS = [
  'Program log: Instruction: Migrate',
  'Program log: Instruction: WithdrawAndMigrate',
] as const;

/**
 * Detect migration from transaction log lines.
 *
 * Returns true if the logs contain a Pump.fun migration instruction.
 * This is a structural check — no strategy decisions.
 */
export function detectFromLogs(logs: readonly string[]): boolean {
  for (const line of logs) {
    for (const pattern of MIGRATION_LOG_PATTERNS) {
      if (line === pattern) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// State-based detection
// ---------------------------------------------------------------------------

/**
 * Detect migration status from bonding curve `complete` field.
 *
 * @param complete  The `complete` boolean from BondingCurveState.
 * @returns 'GRADUATED' if complete is true, 'BONDING' otherwise.
 */
export function detectFromComplete(complete: boolean): MigrationStatus {
  return complete ? 'GRADUATED' : 'BONDING';
}

// ---------------------------------------------------------------------------
// MigrationDetector class
// ---------------------------------------------------------------------------

/**
 * Stateful migration detector that fetches bonding curve state from RPC.
 */
export class MigrationDetector {
  private readonly rpcClient: RpcClient;

  constructor(rpcClient: RpcClient) {
    this.rpcClient = rpcClient;
  }

  /**
   * Check the migration status for a Pump.fun token.
   *
   * Derives the bonding curve PDA, fetches the account, and parses the
   * `complete` field. Returns UNKNOWN if the account cannot be fetched
   * or parsed.
   */
  async checkStatus(mint: MintAddress): Promise<MigrationInfo> {
    const mintPubkey = new PublicKey(mint);
    const bondingCurvePDA = deriveBondingCurvePDA(mintPubkey);

    try {
      const accountInfo = await this.rpcClient.getAccountInfo(bondingCurvePDA);

      if (accountInfo === null) {
        logger.warn('Bonding curve account not found', { mint });
        return {
          mint,
          status: 'UNKNOWN',
          detectedAt: nowMs(),
          slot: null,
          signature: null,
        };
      }

      const data = accountInfo.data as Buffer;
      const parsed = parseBondingCurveData(data);

      if (parsed === null) {
        logger.warn('Failed to parse bonding curve data', {
          mint,
          dataLength: data.length,
        });
        return {
          mint,
          status: 'UNKNOWN',
          detectedAt: nowMs(),
          slot: null,
          signature: null,
        };
      }

      const status = detectFromComplete(parsed.complete);

      logger.debug('Migration status checked', {
        mint,
        status,
        complete: parsed.complete,
      });

      return {
        mint,
        status,
        detectedAt: nowMs(),
        slot: null,
        signature: null,
      };
    } catch (err: unknown) {
      logger.error('Failed to check migration status', {
        mint,
        err: err instanceof Error ? err.message : String(err),
      });

      return {
        mint,
        status: 'UNKNOWN',
        detectedAt: nowMs(),
        slot: null,
        signature: null,
      };
    }
  }
}
