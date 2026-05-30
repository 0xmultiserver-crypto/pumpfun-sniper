
/**
 * Calculate entry price in scaled lamports per raw token unit.
 * Uses 10^6 scaling to avoid BigInt truncation for small amounts.
 * @param amountSol - Buy amount in lamports
 * @param amountTokens - Token amount in raw units
 */
export function computeEntryPriceScaled(amountSol: bigint, amountTokens: bigint): bigint {
  if (amountTokens <= 0n) return 0n;
  return amountSol * 10n**6n / amountTokens;
}

/**
 * Calculate bonding curve price in scaled lamports per raw token unit.
 * Uses 10^6 scaling to avoid BigInt truncation for small amounts.
 * PumpFun virtualSolReserves is in lamports (confirmed: initial state = 30 SOL = 30B lamports).
 * @param virtualSolReserves - From bonding curve (lamports)
 * @param virtualTokenReserves - From bonding curve (raw units)
 */
export function computeBondingCurvePriceScaled(virtualSolReserves: bigint, virtualTokenReserves: bigint): bigint {
  if (virtualTokenReserves <= 0n) return 0n;
  return virtualSolReserves * 10n**6n / virtualTokenReserves;
}
