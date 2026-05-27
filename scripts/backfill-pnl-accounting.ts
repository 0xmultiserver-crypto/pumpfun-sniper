import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Pool } from 'pg';
import {
  deriveBuyAmountSolFromAccounting,
  deriveSellAmountSolFromAccounting,
  getWalletSolAccountingFromParsedTx,
} from '../src/app/execution/onChainAccounting.js';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL missing');
const rpcUrl = process.env.RPC_URL
  ?? process.env.HELIUS_RPC_URL
  ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : undefined);
if (!rpcUrl) throw new Error('RPC_URL/HELIUS_RPC_URL/HELIUS_API_KEY missing');

const pool = new Pool({ connectionString: dbUrl });
const connection = new Connection(rpcUrl, 'confirmed');
const walletSecret = process.env.WALLET_SECRET_KEY;
if (!walletSecret) throw new Error('WALLET_SECRET_KEY missing');
const wallet = Keypair.fromSecretKey(new Uint8Array(Buffer.from(walletSecret, 'base64'))).publicKey;

type Row = {
  id: string;
  side: 'BUY' | 'SELL';
  amount_sol: string;
  signature: string;
};

async function deriveAmount(signature: string, side: 'BUY' | 'SELL'): Promise<bigint | null> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  const accounting = getWalletSolAccountingFromParsedTx(tx, wallet as PublicKey);
  if (!accounting) return null;
  return side === 'BUY'
    ? deriveBuyAmountSolFromAccounting(accounting)
    : deriveSellAmountSolFromAccounting(accounting);
}

async function main() {
  const { rows } = await pool.query<Row>(`
    SELECT id, side, amount_sol::text, signature
    FROM trades
    WHERE status = 'CONFIRMED'
      AND signature IS NOT NULL
      AND signature <> ''
      AND submitted_at >= now() - interval '3 days'
    ORDER BY submitted_at ASC
  `);

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const changes: Array<{ id: string; side: string; oldAmount: string; newAmount: string; delta: string }> = [];

  for (const row of rows) {
    const actual = await deriveAmount(row.signature, row.side);
    if (actual === null || actual <= 0n) {
      skipped += 1;
      continue;
    }
    const oldAmount = BigInt(row.amount_sol);
    if (oldAmount === actual) {
      unchanged += 1;
      continue;
    }
    await pool.query('UPDATE trades SET amount_sol = $1 WHERE id = $2', [actual.toString(), row.id]);
    updated += 1;
    changes.push({
      id: row.id,
      side: row.side,
      oldAmount: oldAmount.toString(),
      newAmount: actual.toString(),
      delta: (actual - oldAmount).toString(),
    });
  }

  console.log(JSON.stringify({ wallet: wallet.toBase58(), scanned: rows.length, updated, unchanged, skipped, changes }, null, 2));
}

main().finally(async () => {
  await pool.end();
});
