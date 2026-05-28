import { Connection, PublicKey } from '@solana/web3.js';
import { deriveBondingCurvePDA } from './dist/adapters/protocols/pumpfun/shared.js';
import { parseBondingCurveData } from './dist/adapters/protocols/pumpfun/tokenParser.js';

const conn = new Connection('https://mainnet.helius-rpc.com');
const mint = new PublicKey('DYF2KDqyTEHaijPctLyDxwA4LWuX6quj56LxoUvpump');
const pda = deriveBondingCurvePDA(mint);
const acc = await conn.getAccountInfo(pda);
if (acc?.data) {
  const parsed = parseBondingCurveData(acc.data);
  console.log('complete:', parsed?.complete);
  console.log('virtualSolReserves:', parsed?.virtualSolReserves?.toString());
  console.log('virtualTokenReserves:', parsed?.virtualTokenReserves?.toString());
} else {
  console.log('No bonding curve account found (likely graduated)');
}
