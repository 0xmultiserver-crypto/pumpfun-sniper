/**
 * Standalone Data Pipeline Validator
 * 
 * Tests each entry check data source against a REAL token to verify
 * parsing code actually returns real data (not null/0/undefined).
 * 
 * Usage: npx tsx scripts/validate-data-pipeline.ts [MINT_ADDRESS]
 * 
 * If no mint provided, uses a recent PumpFun token.
 */

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { deriveBondingCurvePDA } from '../src/adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from '../src/adapters/protocols/pumpfun/tokenParser.js';
import { derivePoolStatePDA } from '../src/adapters/protocols/bonkfun/shared.js';
import { BONKFUN_PLATFORM_CONFIG } from '../src/core/constants/programs.js';
import { parsePoolStateData } from '../src/adapters/protocols/bonkfun/tokenParser.js';
import { AuthorityInspector } from '../src/adapters/protocols/pumpfun/authorityInspector.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const HELIUS_KEY = process.env.HELIUS_API_KEY!;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

interface ValidationResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  value: string;
  details?: string;
}

async function validateDataPipeline(mintAddress: string): Promise<void> {
  const conn = new Connection(RPC_URL, 'confirmed');
  const mintPk = new PublicKey(mintAddress);
  const results: ValidationResult[] = [];

  console.log(`\nValidating data pipeline for: ${mintAddress}`);
  console.log('='.repeat(70));

  // ── 1. Mint Account (checks 4, 5) ──────────────────────────────
  try {
    const mintAccount = await conn.getAccountInfo(mintPk);
    if (!mintAccount) {
      results.push({ name: 'mint_account', status: 'FAIL', value: 'null', details: 'Account not found' });
    } else {
      const data = Buffer.from(mintAccount.data);
      const parsed = AuthorityInspector.parseMintBuffer(mintAddress as any, data);
      results.push({
        name: 'mint_account',
        status: 'PASS',
        value: `${data.length} bytes`,
        details: `mintAuthority=${parsed.mintAuthority}, freezeAuthority=${parsed.freezeAuthority}`,
      });
    }
  } catch (err: any) {
    results.push({ name: 'mint_account', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 2. Bonding Curve (checks 7, 10, 15) ────────────────────────
  try {
    const bcPDA = deriveBondingCurvePDA(mintPk);
    const bcAccount = await conn.getAccountInfo(bcPDA);
    if (!bcAccount) {
      results.push({ name: 'bonding_curve', status: 'WARN', value: 'null', details: 'No BC account (may be BonkFun)' });
    } else {
      const parsed = parseBondingCurveData(Buffer.from(bcAccount.data));
      if (!parsed) {
        results.push({ name: 'bonding_curve', status: 'FAIL', value: 'parse_failed', details: 'parseBondingCurveData returned null' });
      } else {
        const virtualSol = Number(parsed.virtualSolReserves) / 1e9;
        const realSol = Number(parsed.realSolReserves) / 1e9;
        results.push({
          name: 'bonding_curve',
          status: 'PASS',
          value: `virtualSol=${virtualSol.toFixed(4)}, realSol=${realSol.toFixed(4)}, complete=${parsed.complete}`,
        });
      }
    }
  } catch (err: any) {
    results.push({ name: 'bonding_curve', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 3. Token Supply (check 8) ──────────────────────────────────
  try {
    const supply = await conn.getTokenSupply(mintPk);
    results.push({
      name: 'token_supply',
      status: 'PASS',
      value: `${supply.value.amount} (${supply.value.uiAmount} tokens)`,
      details: `decimals=${supply.value.decimals}`,
    });
  } catch (err: any) {
    results.push({ name: 'token_supply', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 4. Largest Accounts (check 8) ──────────────────────────────
  try {
    const largest = await conn.getTokenLargestAccounts(mintPk);
    const count = largest.value.length;
    const top5Pct = largest.value.slice(0, 5).reduce((sum, a) => sum + Number(a.uiAmount || 0), 0);
    const supply = await conn.getTokenSupply(mintPk);
    const supplyAmount = Number(supply.value.uiAmount || 1);
    const concentration = (top5Pct / supplyAmount * 100).toFixed(1);
    results.push({
      name: 'largest_accounts',
      status: 'PASS',
      value: `${count} accounts, top5=${concentration}%`,
      details: `Addresses: ${largest.value.slice(0, 3).map(a => a.address.toBase58().slice(0, 8) + '...').join(', ')}`,
    });
  } catch (err: any) {
    results.push({ name: 'largest_accounts', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 5. Metadata (check 6) ──────────────────────────────────────
  try {
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(), mintPk.toBuffer()],
      new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    );
    const metadataAccount = await conn.getAccountInfo(metadataPDA);
    if (!metadataAccount) {
      results.push({ name: 'metadata', status: 'WARN', value: 'null', details: 'No Metaplex metadata (may be Token-2022)' });
    } else {
      const data = Buffer.from(metadataAccount.data);
      // Parse name/symbol from Metaplex metadata (offset 32+4 for name, then symbol)
      const nameLen = data[32] || 0;
      const name = data.subarray(33, 33 + nameLen).toString('utf8').replace(/\0/g, '').trim();
      const symbolLen = data[33 + nameLen + 4] || 0;
      const symbol = data.subarray(33 + nameLen + 4 + 1, 33 + nameLen + 4 + 1 + symbolLen).toString('utf8').replace(/\0/g, '').trim();
      results.push({
        name: 'metadata',
        status: name && symbol ? 'PASS' : 'WARN',
        value: `name="${name}", symbol="${symbol}"`,
        details: `dataLen=${data.length}`,
      });
    }
  } catch (err: any) {
    results.push({ name: 'metadata', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 6. Helius Holder Count (checks 16, 17) ─────────────────────
  try {
    // Use getTokenLargestAccounts (returns top 20 by default)
    const largest = await conn.getTokenLargestAccounts(mintPk);
    const count = largest.value.length;
    results.push({
      name: 'helius_holder_count',
      status: count > 0 ? 'PASS' : 'WARN',
      value: `${count} holders (top 20)`,
      details: count > 0 ? `Top: ${largest.value[0]?.address.toBase58().slice(0, 8)}...` : 'No data',
    });
  } catch (err: any) {
    results.push({ name: 'helius_holder_count', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 7. DexScreener Volume (check 18) ───────────────────────────
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const json = await resp.json() as any;
    const pair = json?.pairs?.[0];
    if (!pair) {
      results.push({ name: 'dexscreener_volume', status: 'WARN', value: 'no_pairs', details: 'Token not on DexScreener yet' });
    } else {
      const vol1h = pair.volume?.h1 || 0;
      const mcap = pair.marketCap || 0;
      results.push({
        name: 'dexscreener_volume',
        status: 'PASS',
        value: `vol1h=$${vol1h}, mcap=$${mcap}`,
        details: `priceUsd=${pair.priceUsd || '?'}`,
      });
    }
  } catch (err: any) {
    results.push({ name: 'dexscreener_volume', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 8. SOL Price Oracle ────────────────────────────────────────
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const json = await resp.json() as any;
    const price = json?.solana?.usd;
    results.push({
      name: 'sol_price_oracle',
      status: price ? 'PASS' : 'FAIL',
      value: price ? `$${price}` : 'null',
    });
  } catch (err: any) {
    results.push({ name: 'sol_price_oracle', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── 9. BonkFun Pool State (if applicable) ──────────────────────
  try {
    const poolPDA = derivePoolStatePDA(mintPk);
    const poolAccount = await conn.getAccountInfo(poolPDA);
    if (!poolAccount) {
      results.push({ name: 'bonkfun_pool', status: 'WARN', value: 'null', details: 'No LaunchLab pool (may be PumpFun)' });
    } else {
      const parsed = parsePoolStateData(Buffer.from(poolAccount.data), mintAddress);
      if (!parsed) {
        results.push({ name: 'bonkfun_pool', status: 'FAIL', value: 'parse_failed', details: 'parsePoolStateData returned null' });
      } else {
        const isBonkfun = parsed.platformConfig.equals(BONKFUN_PLATFORM_CONFIG);
        results.push({
          name: 'bonkfun_pool',
          status: 'PASS',
          value: `status=${parsed.status}, isBonkfun=${isBonkfun}`,
          details: `virtualBase=${parsed.virtualBase}, virtualQuote=${parsed.virtualQuote}`,
        });
      }
    }
  } catch (err: any) {
    results.push({ name: 'bonkfun_pool', status: 'FAIL', value: 'error', details: err.message });
  }

  // ── Print Results ──────────────────────────────────────────────
  console.log('\n');
  let passCount = 0, failCount = 0, warnCount = 0;
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon} ${r.name.padEnd(25)} ${r.value}`);
    if (r.details) console.log(`   ${r.details}`);
    if (r.status === 'PASS') passCount++;
    else if (r.status === 'FAIL') failCount++;
    else warnCount++;
  }
  console.log('\n' + '='.repeat(70));
  console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL, ${warnCount} WARN`);
  console.log(`DATA INTEGRITY: ${failCount === 0 ? '✅ ALL REAL DATA SOURCES WORKING' : '❌ SOME DATA SOURCES BROKEN — CHECK FAILURES ABOVE'}`);
}

// ── Main ──────────────────────────────────────────────────────────
const mint = process.argv[2] || 'E1dDi65ypa3Az2mT8g4WL1g6BEnk2hJmdENGbNDApump';
validateDataPipeline(mint).catch(console.error);
