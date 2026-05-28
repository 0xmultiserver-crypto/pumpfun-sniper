/**
 * Pump.fun Migration Detector
 *
 * Detects when a Pump.fun token has graduated (migrated to Raydium).
 * Uses transaction log analysis.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

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
