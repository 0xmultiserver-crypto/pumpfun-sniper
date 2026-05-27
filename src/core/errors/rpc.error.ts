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

/** RPC rate limited */
export class RpcRateLimitError extends RpcError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RPC_RATE_LIMIT', context);
    this.name = 'RpcRateLimitError';
  }
}

/** RPC connection lost */
export class RpcConnectionError extends RpcError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RPC_CONNECTION_LOST', context);
    this.name = 'RpcConnectionError';
  }
}

/** WebSocket disconnection */
export class WebSocketDisconnectError extends RpcError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'WS_DISCONNECTED', context);
    this.name = 'WebSocketDisconnectError';
  }
}
