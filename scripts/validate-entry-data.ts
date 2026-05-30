/**
 * Entry Check Data Pipeline Validator
 * Tests each data source against a REAL token to verify fetching works.
 * 
 * Usage: npx tsx scripts/validate-entry-data.ts [MINT]
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { deriveBondingCurvePDA, parseBondingCurveData } from '../src/adapters/protocols/pumpfun/tokenParser.js';
import { derivePoolStatePDA, parsePoolStateData } from '../src/adapters/protocols/bonkfun/tokenParser.js';
import { BONKFUN_PLATFORM_CONFIG, MIN_BONKFUN_POOL_STATE_SIZE, TOKEN_PROGRAM_ID } from '../src/core/constants/programs.js';
import { computeBondingCurvePriceScaled } from '../src/core/utils/price.js';
import { evaluateAuthority, evaluateLiquidity, evaluateMetadata, evaluateConcentration } from '../src/app/entryCheckEvaluator.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import dotenv from 'dotenv';
dotenv.config();

const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const conn = new Connection(rpcUrl, 'confirmed');
const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? '';

// Use a recent PumpFun token from DB
const DEFAULT_MINT = '9Y4cEMr3V9euZAHEnaKjKV3fVjuiUUtL9U5VxDj5pump';
const mint = process.argv[2] ?? DEFAULT_MINT;
const mintPk = new PublicKey(mint);

let passCount = 0;
let failCount = 0;

function check(label: string, ok: boolean, detail: string = '') {
  if (ok) { passCount++; console.log(`  ✅ ${label} ${detail}`); }
  else { failCount++; console.log(`  ❌ ${label} ${detail}`); }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ENTRY CHECK DATA PIPELINE VALIDATOR`);
  console.log(`Mint: ${mint}`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Fetch 1: Mint Account ──
  console.log('FETCH 1: Mint Account (authority checks)');
  const mintAccount = await conn.getAccountInfo(mintPk).catch(() => null);
  check('mintAccount fetched', mintAccount !== null, `data.length=${mintAccount?.data.length}`);
  const { mintAuthorityRevoked, freezeAuthorityRevoked } = evaluateAuthority(mint, mintAccount);
  check('mintAuthorityRevoked', mintAuthorityRevoked);
  check('freezeAuthorityRevoked', freezeAuthorityRevoked);

  // ── Fetch 2: Bonding Curve ──
  console.log('\nFETCH 2: Bonding Curve (liquidity + price)');
  const bcPDA = deriveBondingCurvePDA(mintPk);
  const bcAccount = await conn.getAccountInfo(bcPDA).catch(() => null);
  check('bcAccount fetched', bcAccount !== null, `data.length=${bcAccount?.data.length}`);

  let parsedBC: ReturnType<typeof parseBondingCurveData> = null;
  if (bcAccount?.data && bcAccount.data.length >= 49) {
    parsedBC = parseBondingCurveData(bcAccount.data);
    check('parsedBC', parsedBC !== null);
    if (parsedBC) {
      check('virtualSolReserves > 0', parsedBC.virtualSolReserves > 0n, `=${parsedBC.virtualSolReserves}`);
      check('virtualTokenReserves > 0', parsedBC.virtualTokenReserves > 0n, `=${parsedBC.virtualTokenReserves}`);
      check('realSolReserves exists', parsedBC.realSolReserves >= 0n, `=${parsedBC.realSolReserves}`);
      const price = computeBondingCurvePriceScaled(parsedBC.virtualSolReserves, parsedBC.virtualTokenReserves);
      check('price scaled > 0', price > 0n, `=${price}`);
    }
  } else {
    console.log('  ⚠️  No bonding curve (may be BonkFun or graduated)');
  }

  // ── Fetch 3: Metadata ──
  console.log('\nFETCH 3: Metadata (name/symbol check)');
  const metadataPDA = deriveMetadataPDA(mintPk);
  const metadataAccount = await conn.getAccountInfo(metadataPDA).catch(() => null);
  check('metadataAccount fetched', metadataAccount !== null, `data.length=${metadataAccount?.data.length}`);
  const { metadataSane, parsed: metadataParsed } = evaluateMetadata(mint, metadataAccount, mintAccount);
  check('metadataSane', metadataSane, metadataParsed ? `name="${metadataParsed.name}" symbol="${metadataParsed.symbol}"` : '');

  // ── Fetch 4: Token Largest Accounts ──
  console.log('\nFETCH 4: Token Largest Accounts (concentration)');
  const largestAccounts = await conn.getTokenLargestAccounts(mintPk).catch(() => null);
  check('largestAccounts fetched', largestAccounts !== null, `count=${largestAccounts?.value.length}`);
  
  // Filter BC ATA
  let filtered = largestAccounts?.value ?? null;
  if (filtered && bcAccount) {
    const bcATA = getAssociatedTokenAddressSync(mintPk, bcPDA, true, TOKEN_PROGRAM_ID);
    const bcPDAStr = bcPDA.toBase58();
    const before = filtered.length;
    filtered = filtered.filter(acc => {
      const addr = typeof acc.address === 'string' ? acc.address : acc.address.toBase58();
      return addr !== bcPDAStr && addr !== bcATA.toBase58();
    });
    check('BC ATA filtered', filtered.length < before, `${before} → ${filtered.length}`);
  }

  // ── Fetch 5: Token Supply ──
  console.log('\nFETCH 5: Token Supply');
  const supply = await conn.getTokenSupply(mintPk).catch(() => null);
  check('supply fetched', supply !== null, `amount=${supply?.value.amount}`);

  // ── Check 7: Liquidity ──
  console.log('\nCHECK 7: Liquidity Sane');
  const { liquiditySane } = evaluateLiquidity(bcAccount, null);
  check('liquiditySane', liquiditySane);

  // ── Check 8: Concentration ──
  console.log('\nCHECK 8: Wallet Concentration');
  const concentrationOk = evaluateConcentration(filtered, supply?.value.amount ?? null);
  check('concentration acceptable', concentrationOk);

  // ── Check 10: Price Impact ──
  console.log('\nCHECK 10: Price Impact');
  if (parsedBC && parsedBC.virtualSolReserves > 0n) {
    const positionSizeLamports = 2_400_000n; // ~$0.20 at $150 SOL
    const impactBps = Number(positionSizeLamports * 10000n) / Number(parsedBC.virtualSolReserves * 10n + positionSizeLamports);
    check('priceImpactBps calculated', true, `=${impactBps.toFixed(2)} bps (max 500)`);
  } else {
    console.log('  ⚠️  No BC data — price impact not calculable');
  }

  // ── Check 15: Real SOL Reserves ──
  console.log('\nCHECK 15: Real SOL Reserves');
  if (parsedBC) {
    const realSol = Number(parsedBC.realSolReserves) / 1e9;
    check('realSolReserves', parsedBC.realSolReserves >= 500_000_000n, `=${realSol.toFixed(4)} SOL (min 0.5)`);
  }

  // ── Check 17: Market Cap ──
  console.log('\nCHECK 17: Market Cap');
  if (parsedBC && supply?.value) {
    const priceScaled = computeBondingCurvePriceScaled(parsedBC.virtualSolReserves, parsedBC.virtualTokenReserves);
    const totalSupply = BigInt(supply.value.amount);
    const mcapLamports = priceScaled * totalSupply;
    const mcapUsd = Number(mcapLamports / 10n ** 15n) * 150; // $150 SOL
    check('marketCapUsd calculated', mcapUsd > 0, `=$${mcapUsd.toFixed(2)}`);
  }

  // ── BonkFun Pool State ──
  console.log('\nFETCH 7: BonkFun Pool State');
  const poolPDA = derivePoolStatePDA(mintPk);
  const poolAccount = await conn.getAccountInfo(poolPDA).catch(() => null);
  check('poolAccount fetched', poolAccount !== null, `data.length=${poolAccount?.data.length}`);
  if (poolAccount?.data && poolAccount.data.length >= MIN_BONKFUN_POOL_STATE_SIZE) {
    const parsedPool = parsePoolStateData(Buffer.from(poolAccount.data), mint);
    check('parsedPool', parsedPool !== null);
    if (parsedPool) {
      check('isBonkfun', parsedPool.platformConfig.equals(BONKFUN_PLATFORM_CONFIG));
    }
  } else {
    console.log('  ⚠️  No BonkFun pool (expected for PumpFun tokens)');
  }

  // ── Holder Count (Helius) ──
  console.log('\nCHECK 16-17: Holder Count (Helius)');
  try {
    const url = `https://api.helius.xyz/v0/token-owners?api-key=${HELIUS_API_KEY}&mint=${mint}&page=1&limit=1`;
    const resp = await fetch(url);
    const data = await resp.json() as any;
    const total = data?.total ?? data?.result?.total ?? null;
    check('holderCount from Helius', total !== null, `=${total}`);
  } catch (e) {
    console.log('  ❌ Helius holder count FAILED:', e);
    failCount++;
  }

  // ── Volume (DexScreener) ──
  console.log('\nCHECK 18: Volume (DexScreener)');
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await resp.json() as any;
    const pair = data.pairs?.[0];
    if (pair) {
      const vol1h = pair.volume?.h1 ?? 0;
      const mcap = pair.marketCap ?? 0;
      check('DexScreener volume', vol1h > 0, `1h=$${vol1h}, mcap=$${mcap}`);
    } else {
      console.log('  ⚠️  No DexScreener pair');
    }
  } catch (e) {
    console.log('  ❌ DexScreener FAILED:', e);
    failCount++;
  }

  // ── SOL Price ──
  console.log('\nSOL PRICE ORACLE');
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await resp.json() as any;
    const price = data?.solana?.usd;
    check('SOL price from CoinGecko', price > 0, `=$${price}`);
  } catch (e) {
    console.log('  ❌ CoinGecko FAILED:', e);
    failCount++;
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  console.log(`${'='.repeat(60)}`);
}

main().catch(console.error);
