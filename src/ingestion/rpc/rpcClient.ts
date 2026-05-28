/**
 * RPC Client — thin wrapper around @solana/web3.js Connection.
 * Ingestion layer only: no strategy / business logic.
 */

import {
  Connection,
  type AccountInfo,
  type Commitment,
  PublicKey,
} from '@solana/web3.js';

import { RpcError, RpcTimeoutError } from '../../core/errors/rpc.error.js';
import { recordRpcCall, recordRpcError } from '../../telemetry/metrics/ingestionMetrics.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { RateLimiter } from './rateLimiter.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RpcClientConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly commitment: 'processed' | 'confirmed' | 'finalized';
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('rpc.client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnaborted');
  }
  return false;
}

function classifyError(err: unknown): string {
  if (isTimeoutError(err)) return 'timeout';
  if (err instanceof Error && err.message.toLowerCase().includes('rate')) return 'rate_limit';
  return 'unknown';
}

function wrapError(method: string, err: unknown): never {
  if (err instanceof RpcError) {
    throw err;
  }
  if (isTimeoutError(err)) {
    throw new RpcTimeoutError(`RPC timeout in ${method}: ${String(err)}`, { method });
  }
  throw new RpcError(
    `RPC error in ${method}: ${String(err)}`,
    'RPC_CALL_FAILED',
    { method },
  );
}

// ---------------------------------------------------------------------------
// RpcClient
// ---------------------------------------------------------------------------

export class RpcClient {
  private readonly connection: Connection;
  private readonly rateLimiter: RateLimiter;
  public readonly config: Readonly<RpcClientConfig>;

  constructor(config: RpcClientConfig) {
    this.config = Object.freeze({ ...config });
    this.connection = new Connection(config.url, {
      commitment: config.commitment as Commitment,
      confirmTransactionInitialTimeout: config.timeoutMs,
    });
    this.rateLimiter = new RateLimiter();
  }

  /** Expose underlying Connection for advanced usage (websocket subscriptions etc.) */
  get raw(): Connection {
    return this.connection;
  }

  /** URL of this RPC endpoint. */
  get endpoint(): string {
    return this.config.url;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async getBalance(pubkey: PublicKey): Promise<bigint> {
    const method = 'getBalance';
    const start = nowMs();
    try {
      const lamports = await this.rateLimiter.execute(() =>
        this.connection.getBalance(pubkey, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getBalance', { method, pubkey: pubkey.toBase58(), lamports });
      return BigInt(lamports);
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getBalance failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getSlot(): Promise<number> {
    const method = 'getSlot';
    const start = nowMs();
    try {
      const slot = await this.rateLimiter.execute(() =>
        this.connection.getSlot(this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getSlot', { method, slot });
      return slot;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getSlot failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getLatestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }> {
    const method = 'getLatestBlockhash';
    const start = nowMs();
    try {
      const result = await this.rateLimiter.execute(() =>
        this.connection.getLatestBlockhash(this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getLatestBlockhash', { method, blockhash: result.blockhash });
      return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight };
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getLatestBlockhash failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async sendRawTransaction(tx: Buffer | Uint8Array): Promise<string> {
    const method = 'sendRawTransaction';
    const start = nowMs();
    try {
      const signature = await this.rateLimiter.execute(() =>
        this.connection.sendRawTransaction(tx, {
          skipPreflight: true,
          maxRetries: 0,
        }),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('sendRawTransaction', { method, signature });
      return signature;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('sendRawTransaction failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async confirmTransaction(
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<boolean> {
    const method = 'confirmTransaction';
    const start = nowMs();
    try {
      const result = await this.rateLimiter.execute(() =>
        this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.config.commitment as Commitment,
        ),
      );
      recordRpcCall(method, nowMs() - start);
      const confirmed = result.value.err === null;
      logger.debug('confirmTransaction', { method, signature, confirmed });
      return confirmed;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('confirmTransaction failed', { method, signature, err: String(err) });
      wrapError(method, err);
    }
  }

  async getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    const method = 'getAccountInfo';
    const start = nowMs();
    try {
      const info = await this.rateLimiter.execute(() =>
        this.connection.getAccountInfo(pubkey, this.config.commitment as Commitment),
      );
      recordRpcCall(method, nowMs() - start);
logger.debug('getAccountInfo', { method, pubkey: pubkey.toBase58(), found: info !== null });
      return info;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getAccountInfo failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  async getMultipleAccountsInfo(
    pubkeys: readonly PublicKey[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const method = 'getMultipleAccountsInfo';
    const start = nowMs();
    try {
      const mutableKeys = [...pubkeys];
      const infos = await this.rateLimiter.execute(() =>
        this.connection.getMultipleAccountsInfo(
          mutableKeys,
          this.config.commitment as Commitment,
        ),
      );
      recordRpcCall(method, nowMs() - start);
      logger.debug('getMultipleAccountsInfo', { method, count: pubkeys.length });
      return infos;
    } catch (err: unknown) {
      recordRpcError(method, classifyError(err));
      logger.error('getMultipleAccountsInfo failed', { method, err: String(err) });
      wrapError(method, err);
    }
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  async isHealthy(): Promise<boolean> {
    try {
      await this.rateLimiter.execute(() =>
        this.connection.getSlot(this.config.commitment as Commitment),
      );
      return true;
    } catch (_err: unknown) {
      logger.warn('Health check failed', { endpoint: this.endpoint });
      return false;
    }
  }
}
