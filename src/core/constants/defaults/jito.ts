/**
 * Jito MEV protection defaults.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 */

// ---------------------------------------------------------------------------
// Jito MEV Protection
// ---------------------------------------------------------------------------

/**
 * Default Jito tip amount in lamports.
 * 10,000 lamports = 0.00001 SOL.
 * Adjust based on network conditions / desired inclusion priority.
 */
export const JITO_TIP_LAMPORTS = 10_000 as const;
