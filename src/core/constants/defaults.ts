/**
 * Default configuration constants — re-exported from domain sub-modules.
 *
 * Split into focused modules for maintainability:
 *   - trading.ts:      Position sizing, TP/SL, trailing, scale-out
 *   - detection.ts:    Momentum, creator history, entry checks
 *   - infrastructure.ts: RPC, DB, WebSocket, compute budget, SOL price
 *   - risk.ts:         Daily kill switch, cooldown, anti-rug
 *   - jito.ts:         Jito MEV protection
 */

export * from './defaults/trading.js';
export * from './defaults/detection.js';
export * from './defaults/infrastructure.js';
export * from './defaults/risk.js';
export * from './defaults/jito.js';
