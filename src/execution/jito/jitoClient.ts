/**
 * Jito MEV Protection Client
 *
 * Submits transactions via the Jito block engine for MEV protection.
 * Adds a tip instruction to incentivize Jito validators to include the
 * transaction in their block, reducing sandwich attack risk.
 *
 * Design:
 *   - Sends serialized transactions to the Jito block engine REST API
 *   - Picks a random Jito tip account from the known set
 *   - If Jito submission fails, returns error so caller can fall back to
 *     normal RPC submission
 *   - Tracks Prometheus metrics for bundle success/failure rates
 *
 * Execution = tx sending ONLY. No strategy logic.
 */

import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import {
  jitoBundlesTotal,
  jitoFailuresTotal,
} from '../../telemetry/metrics/prometheus.js';
import { JITO_TIP_LAMPORTS } from '../../core/constants/defaults.js';

const logger = createLogger('execution:jitoClient');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Jito block engine mainnet endpoint for direct transaction submission.
 * Source: https://www.jito.wtf/ (Jito docs)
 */
const JITO_BLOCK_ENGINE_URL =
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions';

/**
 * Known Jito tip accounts (mainnet).
 * Source: https://docs.jito.wtf/lowlatencytxnsend/
 * A random one is selected per submission to distribute load.
 */
const JITO_TIP_ACCOUNTS: readonly string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiLMiXRSE',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLbTfaQ9RnhRat22Q7',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Default HTTP timeout for Jito submission (ms). */
const JITO_REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from a Jito bundle submission. */
export interface JitoSendResult {
  /** Transaction signature (null if submission failed). */
  readonly signature: string | null;
  /** Error message (null if submission succeeded). */
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Tip utilities
// ---------------------------------------------------------------------------

/**
 * Pick a random Jito tip account.
 */
export function pickJitoTipAccount(): string {
  const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[index]!;
}

/**
 * Build a SystemProgram.transfer instruction for the Jito tip.
 *
 * Add this instruction to your transaction BEFORE signing, then submit
 * the signed transaction via {@link JitoClient.sendAsJitoBundle}.
 *
 * @param payer        Public key of the tip payer (must be a signer in the tx).
 * @param tipLamports  Amount of lamports to tip (default: JITO_TIP_LAMPORTS).
 */
export function buildJitoTipIx(
  payer: PublicKey,
  tipLamports: number = JITO_TIP_LAMPORTS,
): TransactionInstruction {
  const tipAccount = pickJitoTipAccount();
  logger.debug('Building Jito tip instruction', {
    tipLamports,
    tipAccount,
  });

  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(tipAccount),
    lamports: BigInt(tipLamports),
  });
}

// ---------------------------------------------------------------------------
// JitoClient
// ---------------------------------------------------------------------------

/**
 * Jito block engine client for MEV-protected transaction submission.
 */
export class JitoClient {
  private readonly blockEngineUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: {
    readonly blockEngineUrl?: string;
    readonly timeoutMs?: number;
  }) {
    this.blockEngineUrl = options?.blockEngineUrl ?? JITO_BLOCK_ENGINE_URL;
    this.timeoutMs = options?.timeoutMs ?? JITO_REQUEST_TIMEOUT_MS;
  }

  /**
   * Submit a signed transaction via Jito block engine.
   *
   * The transaction MUST already be signed and MUST already contain
   * a tip instruction (use {@link buildJitoTipIx} to create one).
   *
   * @param serializedTransaction  Raw bytes of a signed transaction.
   * @returns JitoSendResult with signature or error.
   */
  async sendAsJitoBundle(
    serializedTransaction: Uint8Array,
    _tipLamports: number = JITO_TIP_LAMPORTS,
  ): Promise<JitoSendResult> {
    jitoBundlesTotal.inc();

    const encodedTx = Buffer.from(serializedTransaction).toString('base64');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.blockEngineUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [encodedTx, { encoding: 'base64' }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        const error = `Jito HTTP ${response.status}: ${body}`;
        jitoFailuresTotal.inc();
        logger.warn('Jito submission failed (HTTP error)', {
          status: response.status,
          body,
        });
        return { signature: null, error };
      }

      const json = (await response.json()) as {
        readonly result?: string;
        readonly error?: { readonly code?: number; readonly message?: string };
      };

      if (json.error !== undefined) {
        const error = `Jito RPC error ${json.error.code ?? 'unknown'}: ${json.error.message ?? 'unknown'}`;
        jitoFailuresTotal.inc();
        logger.warn('Jito submission failed (RPC error)', {
          code: json.error.code,
          message: json.error.message,
        });
        return { signature: null, error };
      }

      const signature = json.result ?? null;
      if (signature === null) {
        jitoFailuresTotal.inc();
        logger.warn('Jito returned no signature');
        return { signature: null, error: 'Jito returned no signature' };
      }

      logger.info('Jito bundle submitted successfully', { signature });
      return { signature, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      jitoFailuresTotal.inc();
      logger.warn('Jito submission failed (network error)', {
        error: message,
      });
      return { signature: null, error: `Jito network error: ${message}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Shared Jito client instance. */
export const jitoClient = new JitoClient();
