/**
 * RPC error classes.
 *
 * Structured errors for RPC and network failures.
 */

/** Base RPC error */
export class RpcError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.context = context;
  }
}

/** RPC request timeout */
export class RpcTimeoutError extends RpcError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RPC_TIMEOUT', context);
    this.name = 'RpcTimeoutError';
  }
}

/** RPC rate limited (reserved for future use) */
/** RPC connection lost (reserved for future use) */
/** WebSocket disconnection (reserved for future use) */
