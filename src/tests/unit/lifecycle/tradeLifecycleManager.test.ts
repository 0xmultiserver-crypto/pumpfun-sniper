import { describe, it, expect, vi } from 'vitest';
import {
  TradeLifecycleManager,
  type TradeState,
} from '../../../execution/lifecycle/tradeLifecycleManager.js';
import type { MintAddress } from '../../../core/types/token.js';
import type { SwapDirection } from '../../../core/types/execution.js';

const MINT = 'TestMint111111111111111111111111111111111111' as MintAddress;

describe('TradeLifecycleManager', () => {
  it('creates trade in PENDING state', () => {
    const mgr = new TradeLifecycleManager();
    const trade = mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100_000_000n);

    expect(trade.tradeId).toBe('t1');
    expect(trade.mint).toBe(MINT);
    expect(trade.state).toBe('PENDING');
    expect(trade.entryAmountLamports).toBe(100_000_000n);
    expect(trade.entrySignature).toBeNull();
    expect(trade.exitSignature).toBeNull();
    expect(trade.createdAt).toBeGreaterThan(0);
  });

  it('throws on duplicate trade ID', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);

    expect(() => mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n))
      .toThrow('Trade already exists');
  });

  it('transitions PENDING -> SENT -> CONFIRMED', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);

    const sent = mgr.transition('t1', 'SENT', { entrySignature: 'sig123' });
    expect(sent.state).toBe('SENT');
    expect(sent.entrySignature).toBe('sig123');
    expect(sent.sentAt).toBeGreaterThan(0);

    const confirmed = mgr.transition('t1', 'CONFIRMED');
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).toBeGreaterThan(0);
  });

  it('transitions to COMPLETED sets exitedAt', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    mgr.transition('t1', 'SENT');
    mgr.transition('t1', 'CONFIRMED');
    mgr.transition('t1', 'MONITORING');

    const completed = mgr.transition('t1', 'COMPLETED', {
      exitSignature: 'exit_sig',
      exitAmountLamports: 130n,
    });

    expect(completed.state).toBe('COMPLETED');
    expect(completed.exitedAt).toBeGreaterThan(0);
    expect(completed.exitSignature).toBe('exit_sig');
    expect(completed.exitAmountLamports).toBe(130n);
  });

  it('transition to FAILED with failReason', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);

    const failed = mgr.transition('t1', 'FAILED', { failReason: 'tx dropped' });
    expect(failed.state).toBe('FAILED');
    expect(failed.failReason).toBe('tx dropped');
  });

  it('throws on transition for unknown trade', () => {
    const mgr = new TradeLifecycleManager();
    expect(() => mgr.transition('unknown', 'SENT')).toThrow('Trade not found');
  });

  it('getTrade returns null for unknown', () => {
    const mgr = new TradeLifecycleManager();
    expect(mgr.getTrade('nope')).toBeNull();
  });

  it('getTrade returns trade by ID', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    const t = mgr.getTrade('t1');
    expect(t).not.toBeNull();
    expect(t!.tradeId).toBe('t1');
  });

  it('getActiveTrades excludes COMPLETED/FAILED/CANCELLED', () => {
    const mgr = new TradeLifecycleManager();
    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    mgr.createTrade('t2', MINT, 'BUY' as SwapDirection, 100n);
    mgr.createTrade('t3', MINT, 'BUY' as SwapDirection, 100n);

    mgr.transition('t1', 'COMPLETED');
    mgr.transition('t2', 'FAILED');

    const active = mgr.getActiveTrades();
    expect(active).toHaveLength(1);
    expect(active[0]!.tradeId).toBe('t3');
  });

  it('activeTradeCount tracks correctly', () => {
    const mgr = new TradeLifecycleManager();
    expect(mgr.activeTradeCount).toBe(0);

    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    expect(mgr.activeTradeCount).toBe(1);

    mgr.transition('t1', 'CANCELLED');
    expect(mgr.activeTradeCount).toBe(0);
  });

  it('fires onTransition handlers', () => {
    const mgr = new TradeLifecycleManager();
    const handler = vi.fn();
    mgr.onTransition(handler);

    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    mgr.transition('t1', 'SENT');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]!.state).toBe('SENT');
    expect(handler.mock.calls[0]![1]).toBe('PENDING'); // previous state
  });

  it('survives handler that throws', () => {
    const mgr = new TradeLifecycleManager();
    mgr.onTransition(() => { throw new Error('handler boom'); });

    mgr.createTrade('t1', MINT, 'BUY' as SwapDirection, 100n);
    expect(() => mgr.transition('t1', 'SENT')).not.toThrow();
    expect(mgr.getTrade('t1')!.state).toBe('SENT');
  });
});
