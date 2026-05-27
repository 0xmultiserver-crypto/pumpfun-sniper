/**
 * Unit tests for execution/tx/cuEstimator.ts
 *
 * Tests dynamic compute unit estimation with Exponential Moving Average:
 *   - Default fallback when insufficient samples
 *   - EMA convergence after 5+ samples
 *   - Clamping to [100_000, 1_400_000]
 *   - Separate tracking per transaction type
 *   - DB persistence
 */

import { describe, it, expect } from 'vitest';
import { CUEstimator } from '../../../execution/tx/cuEstimator.js';

describe('CUEstimator', () => {
  describe('estimateCu', () => {
    it('returns default 200,000 when no samples recorded', () => {
      const estimator = new CUEstimator();
      expect(estimator.estimateCu('BUY')).toBe(200_000);
      expect(estimator.estimateCu('SELL')).toBe(200_000);
    });

    it('returns default 200,000 with fewer than 5 samples', () => {
      const estimator = new CUEstimator();
      for (let i = 0; i < 4; i++) {
        estimator.recordActualCu('BUY', 150_000);
      }
      expect(estimator.estimateCu('BUY')).toBe(200_000);
    });

    it('uses EMA * 1.2 after 5 samples (constant input)', () => {
      const estimator = new CUEstimator();
      // Record 5 samples of exactly 100,000 CU
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // EMA with constant input = 100,000 → estimate = ceil(100,000 * 1.2) = 120,000
      expect(estimator.estimateCu('BUY')).toBe(120_000);
    });

    it('calculates EMA correctly with varying samples', () => {
      const estimator = new CUEstimator();
      // EMA(alpha=0.3) with samples: 100k, 200k, 150k, 180k, 120k
      // EMA[1] = 100000
      // EMA[2] = 0.3*200000 + 0.7*100000 = 130000
      // EMA[3] = 0.3*150000 + 0.7*130000 = 136000
      // EMA[4] = 0.3*180000 + 0.7*136000 = 149200
      // EMA[5] = 0.3*120000 + 0.7*149200 = 140440
      // estimate = ceil(140440 * 1.2) = 168528
      estimator.recordActualCu('BUY', 100_000);
      estimator.recordActualCu('BUY', 200_000);
      estimator.recordActualCu('BUY', 150_000);
      estimator.recordActualCu('BUY', 180_000);
      estimator.recordActualCu('BUY', 120_000);
      expect(estimator.estimateCu('BUY')).toBe(168_528);
    });

    it('clamps to minimum 100,000 CU', () => {
      const estimator = new CUEstimator();
      // 5 very small samples: EMA = 50,000 → 50k * 1.2 = 60,000 → clamped to 100,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 50_000);
      }
      expect(estimator.estimateCu('BUY')).toBe(100_000);
    });

    it('clamps to maximum 1,400,000 CU', () => {
      const estimator = new CUEstimator();
      // 5 very large samples: EMA = 1,300,000 → 1.3M * 1.2 = 1,560,000 → clamped to 1,400,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 1_300_000);
      }
      expect(estimator.estimateCu('BUY')).toBe(1_400_000);
    });

    it('tracks BUY and SELL independently', () => {
      const estimator = new CUEstimator();
      // BUY: 5 samples of 100k → EMA=100k → estimate = 120k
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // SELL: 5 samples of 200k → EMA=200k → estimate = 240k
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('SELL', 200_000);
      }

      expect(estimator.estimateCu('BUY')).toBe(120_000);
      expect(estimator.estimateCu('SELL')).toBe(240_000);
    });
  });

  describe('recordActualCu', () => {
    it('tracks the number of samples', () => {
      const estimator = new CUEstimator();
      expect(estimator.sampleCount('BUY')).toBe(0);

      estimator.recordActualCu('BUY', 150_000);
      expect(estimator.sampleCount('BUY')).toBe(1);

      estimator.recordActualCu('BUY', 160_000);
      expect(estimator.sampleCount('BUY')).toBe(2);
    });

    it('keeps incrementing sample count (EMA has no window cap)', () => {
      const estimator = new CUEstimator();
      // Record 25 samples
      for (let i = 0; i < 25; i++) {
        estimator.recordActualCu('BUY', 100_000 + i * 1000);
      }
      // EMA tracks all samples, count = 25
      expect(estimator.sampleCount('BUY')).toBe(25);
    });

    it('EMA converges toward new values with enough samples', () => {
      const estimator = new CUEstimator();
      // Fill with 20 samples of 100,000 → EMA = 100,000
      for (let i = 0; i < 20; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // Add 5 samples of 200,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 200_000);
      }
      // EMA should have shifted toward 200k but not fully
      // EMA after 25 samples ≈ 183,193
      // estimate = ceil(183193 * 1.2) = 219,832
      const estimate = estimator.estimateCu('BUY');
      expect(estimate).toBeGreaterThan(200_000);
      expect(estimate).toBeLessThan(240_000);
    });
  });

  describe('currentEma', () => {
    it('returns 0 when no samples', () => {
      const estimator = new CUEstimator();
      expect(estimator.currentEma('BUY')).toBe(0);
    });

    it('returns the EMA value after recording', () => {
      const estimator = new CUEstimator();
      estimator.recordActualCu('BUY', 150_000);
      expect(estimator.currentEma('BUY')).toBe(150_000);
    });
  });

  describe('reset', () => {
    it('clears all samples', () => {
      const estimator = new CUEstimator();
      for (let i = 0; i < 10; i++) {
        estimator.recordActualCu('BUY', 100_000);
        estimator.recordActualCu('SELL', 200_000);
      }
      estimator.reset();
      expect(estimator.sampleCount('BUY')).toBe(0);
      expect(estimator.sampleCount('SELL')).toBe(0);
      expect(estimator.estimateCu('BUY')).toBe(200_000);
    });
  });
});
