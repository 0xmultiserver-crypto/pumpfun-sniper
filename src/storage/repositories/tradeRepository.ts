import { query } from '../postgres/postgresClient.js';
import type { IRepository } from '../../core/interfaces/storage.js';
import type { TradeRecord, TradePair, TradeId } from '../../core/types/trade.js';
import type { ExitReason } from '../../core/types/strategy.js';

// ---------------------------------------------------------------------------
// Row shapes coming back from pg driver (all values are strings / null)
// ---------------------------------------------------------------------------

interface TradeRow {
  readonly id: string;
  readonly mint: string;
  readonly side: string;
  readonly status: string;
  readonly amount_sol: string;
  readonly amount_tokens: string;
  readonly signature: string | null;
  readonly slot: string | null;
  readonly submitted_at: string;
  readonly confirmed_at: string | null;
  readonly failure_reason: string | null;
}

interface TradePairRow {
  readonly id: string;
  readonly mint: string;
  readonly entry_trade_id: string;
  readonly exit_trade_id: string | null;
  readonly entry_price_sol: string;
  readonly exit_price_sol: string | null;
  readonly pnl_sol: string | null;
  readonly pnl_percent: number | null;
  readonly exit_reason: string | null;
  readonly duration_ms: string | null;
}

// Joined row: trade_pairs columns + prefixed entry / exit trade columns
interface TradePairJoinedRow extends TradePairRow {
  // entry trade columns (always present via INNER JOIN)
  readonly e_id: string;
  readonly e_mint: string;
  readonly e_side: string;
  readonly e_status: string;
  readonly e_amount_sol: string;
  readonly e_amount_tokens: string;
  readonly e_signature: string | null;
  readonly e_slot: string | null;
  readonly e_submitted_at: string;
  readonly e_confirmed_at: string | null;
  readonly e_failure_reason: string | null;
  // exit trade columns (null when no exit trade via LEFT JOIN)
  readonly x_id: string | null;
  readonly x_mint: string | null;
  readonly x_side: string | null;
  readonly x_status: string | null;
  readonly x_amount_sol: string | null;
  readonly x_amount_tokens: string | null;
  readonly x_signature: string | null;
  readonly x_slot: string | null;
  readonly x_submitted_at: string | null;
  readonly x_confirmed_at: string | null;
  readonly x_failure_reason: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTradeRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id as TradeId,
    mint: row.mint,
    side: row.side as TradeRecord['side'],
    status: row.status as TradeRecord['status'],
    amountSol: BigInt(row.amount_sol),
    amountTokens: BigInt(row.amount_tokens),
    signature: row.signature,
    slot: row.slot !== null ? Number(row.slot) : null,
    submittedAt: new Date(row.submitted_at).getTime(),
    confirmedAt: row.confirmed_at !== null ? new Date(row.confirmed_at).getTime() : null,
    failureReason: row.failure_reason,
  };
}

function toTradeRecordFromPrefix(
  prefix: 'e' | 'x',
  row: TradePairJoinedRow,
): TradeRecord | null {
  const idVal = prefix === 'e' ? row.e_id : row.x_id;
  if (idVal === null || idVal === undefined) return null;

  const mintVal = prefix === 'e' ? row.e_mint : row.x_mint;
  const sideVal = prefix === 'e' ? row.e_side : row.x_side;
  const statusVal = prefix === 'e' ? row.e_status : row.x_status;
  const amountSolVal = prefix === 'e' ? row.e_amount_sol : row.x_amount_sol;
  const amountTokensVal = prefix === 'e' ? row.e_amount_tokens : row.x_amount_tokens;
  const signatureVal = prefix === 'e' ? row.e_signature : row.x_signature;
  const slotVal = prefix === 'e' ? row.e_slot : row.x_slot;
  const submittedAtVal = prefix === 'e' ? row.e_submitted_at : row.x_submitted_at;
  const confirmedAtVal = prefix === 'e' ? row.e_confirmed_at : row.x_confirmed_at;
  const failureReasonVal = prefix === 'e' ? row.e_failure_reason : row.x_failure_reason;

  // Guard against null join columns (satisfies strict null checks)
  if (
    mintVal === null || mintVal === undefined ||
    sideVal === null || sideVal === undefined ||
    statusVal === null || statusVal === undefined ||
    amountSolVal === null || amountSolVal === undefined ||
    amountTokensVal === null || amountTokensVal === undefined ||
    submittedAtVal === null || submittedAtVal === undefined
  ) {
    return null;
  }

  return {
    id: idVal as TradeId,
    mint: mintVal,
    side: sideVal as TradeRecord['side'],
    status: statusVal as TradeRecord['status'],
    amountSol: BigInt(amountSolVal),
    amountTokens: BigInt(amountTokensVal),
    signature: signatureVal ?? null,
    slot: slotVal !== null && slotVal !== undefined ? Number(slotVal) : null,
    submittedAt: new Date(submittedAtVal).getTime(),
    confirmedAt: confirmedAtVal !== null && confirmedAtVal !== undefined
      ? new Date(confirmedAtVal).getTime()
      : null,
    failureReason: failureReasonVal ?? null,
  };
}

function toTradePair(row: TradePairJoinedRow): TradePair {
  const entry = toTradeRecordFromPrefix('e', row);
  if (entry === null) {
    throw new Error(`Trade pair ${row.id} has no valid entry trade`);
  }

  const exit = toTradeRecordFromPrefix('x', row);

  return {
    id: row.id as TradeId,
    mint: row.mint,
    entry,
    exit,
    entryPriceSol: BigInt(row.entry_price_sol),
    exitPriceSol: row.exit_price_sol !== null ? BigInt(row.exit_price_sol) : null,
    pnlSol: row.pnl_sol !== null ? BigInt(row.pnl_sol) : null,
    pnlPercent: row.pnl_percent,
    exitReason: row.exit_reason !== null ? (row.exit_reason as ExitReason) : null,
    skipReason: null,
    durationMs: row.duration_ms !== null ? Number(row.duration_ms) : null,
  };
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

const TRADE_PAIR_JOIN_SQL = `
  SELECT
    tp.id, tp.mint, tp.entry_trade_id, tp.exit_trade_id,
    tp.entry_price_sol, tp.exit_price_sol, tp.pnl_sol,
    tp.pnl_percent, tp.exit_reason, tp.duration_ms,
    e.id        AS e_id,
    e.mint      AS e_mint,
    e.side      AS e_side,
    e.status    AS e_status,
    e.amount_sol     AS e_amount_sol,
    e.amount_tokens  AS e_amount_tokens,
    e.signature      AS e_signature,
    e.slot           AS e_slot,
    e.submitted_at   AS e_submitted_at,
    e.confirmed_at   AS e_confirmed_at,
    e.failure_reason AS e_failure_reason,
    x.id        AS x_id,
    x.mint      AS x_mint,
    x.side      AS x_side,
    x.status    AS x_status,
    x.amount_sol     AS x_amount_sol,
    x.amount_tokens  AS x_amount_tokens,
    x.signature      AS x_signature,
    x.slot           AS x_slot,
    x.submitted_at   AS x_submitted_at,
    x.confirmed_at   AS x_confirmed_at,
    x.failure_reason AS x_failure_reason
  FROM trade_pairs tp
  INNER JOIN trades e ON e.id = tp.entry_trade_id
  LEFT  JOIN trades x ON x.id = tp.exit_trade_id
` as const;

// ---------------------------------------------------------------------------
// TradeRepository
// ---------------------------------------------------------------------------

export class TradeRepository implements IRepository<TradeRecord, TradeId> {
  async findById(id: TradeId): Promise<TradeRecord | null> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE id = $1',
      values: [id],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row === undefined) return null;

    return toTradeRecord(row);
  }

  async save(record: TradeRecord): Promise<void> {
    await query({
      text: `INSERT INTO trades (
        id, mint, side, status, amount_sol, amount_tokens,
        signature, slot, submitted_at, confirmed_at, failure_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        to_timestamp($9::double precision / 1000),
        CASE WHEN $10::double precision IS NOT NULL
             THEN to_timestamp($10::double precision / 1000)
             ELSE NULL END,
        $11
      )
      ON CONFLICT (id) DO UPDATE SET
        mint           = EXCLUDED.mint,
        side           = EXCLUDED.side,
        status         = EXCLUDED.status,
        amount_sol     = EXCLUDED.amount_sol,
        amount_tokens  = EXCLUDED.amount_tokens,
        signature      = EXCLUDED.signature,
        slot           = EXCLUDED.slot,
        submitted_at   = EXCLUDED.submitted_at,
        confirmed_at   = EXCLUDED.confirmed_at,
        failure_reason = EXCLUDED.failure_reason
      WHERE NOT (trades.status = 'CONFIRMED' AND EXCLUDED.status = 'FAILED')`,
      values: [
        record.id,
        record.mint,
        record.side,
        record.status,
        record.amountSol.toString(),
        record.amountTokens.toString(),
        record.signature,
        record.slot,
        record.submittedAt,
        record.confirmedAt,
        record.failureReason,
      ],
    });
  }

  async delete(id: TradeId): Promise<void> {
    await query({
      text: 'DELETE FROM trades WHERE id = $1',
      values: [id],
    });
  }

  async findByMint(mint: string): Promise<readonly TradeRecord[]> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE mint = $1 ORDER BY submitted_at ASC',
      values: [mint],
    });

    return result.rows.map(toTradeRecord);
  }

  async findBySignature(signature: string): Promise<TradeRecord | null> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE signature = $1',
      values: [signature],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row === undefined) return null;

    return toTradeRecord(row);
  }

  /**
   * Confirmed BUY rows that do not yet have a confirmed SELL row.
   *
   * Used at startup to rehydrate in-memory position monitoring from Postgres.
   * This closes the restart gap where DB has an open buy, but the strategy's
   * monitoredTrades Set is empty, so TIMEOUT/TP/SL never fires.
   */
  async findOpenConfirmedBuys(): Promise<readonly TradeRecord[]> {
    const result = await query<TradeRow>({
      text: `SELECT b.*
        FROM trades b
        WHERE b.side = 'BUY'
          AND b.status = 'CONFIRMED'
          AND b.amount_tokens > 0
          AND NOT EXISTS (
            SELECT 1
            FROM trades s
            WHERE s.side = 'SELL'
              AND s.status = 'CONFIRMED'
              AND s.id = ('sell-' || b.id)
          )
        ORDER BY COALESCE(b.confirmed_at, b.submitted_at) ASC`,
      values: [],
    });

    return result.rows.map(toTradeRecord);
  }
}

// ---------------------------------------------------------------------------
// TradePairRepository
// ---------------------------------------------------------------------------

export class TradePairRepository implements IRepository<TradePair, TradeId> {
  async findById(id: TradeId): Promise<TradePair | null> {
    const result = await query<TradePairJoinedRow>({
      text: `${TRADE_PAIR_JOIN_SQL} WHERE tp.id = $1`,
      values: [id],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row === undefined) return null;

    return toTradePair(row);
  }

  async save(pair: TradePair): Promise<void> {
    await query({
      text: `INSERT INTO trade_pairs (
        id, mint, entry_trade_id, exit_trade_id,
        entry_price_sol, exit_price_sol, pnl_sol,
        pnl_percent, exit_reason, duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        mint           = EXCLUDED.mint,
        entry_trade_id = EXCLUDED.entry_trade_id,
        exit_trade_id  = EXCLUDED.exit_trade_id,
        entry_price_sol = EXCLUDED.entry_price_sol,
        exit_price_sol = EXCLUDED.exit_price_sol,
        pnl_sol        = EXCLUDED.pnl_sol,
        pnl_percent    = EXCLUDED.pnl_percent,
        exit_reason    = EXCLUDED.exit_reason,
        duration_ms    = EXCLUDED.duration_ms`,
      values: [
        pair.id,
        pair.mint,
        pair.entry.id,
        pair.exit?.id ?? null,
        pair.entryPriceSol.toString(),
        pair.exitPriceSol?.toString() ?? null,
        pair.pnlSol?.toString() ?? null,
        pair.pnlPercent,
        pair.exitReason,
        pair.durationMs,
      ],
    });
  }

  async delete(id: TradeId): Promise<void> {
    await query({
      text: 'DELETE FROM trade_pairs WHERE id = $1',
      values: [id],
    });
  }

  async findByMint(mint: string): Promise<readonly TradePair[]> {
    const result = await query<TradePairJoinedRow>({
      text: `${TRADE_PAIR_JOIN_SQL} WHERE tp.mint = $1 ORDER BY e.submitted_at ASC`,
      values: [mint],
    });

    return result.rows.map(toTradePair);
  }

  async findOpenPairs(): Promise<readonly TradePair[]> {
    const result = await query<TradePairJoinedRow>({
      text: `${TRADE_PAIR_JOIN_SQL} WHERE tp.exit_trade_id IS NULL ORDER BY e.submitted_at ASC`,
      values: [],
    });

    return result.rows.map(toTradePair);
  }
}
