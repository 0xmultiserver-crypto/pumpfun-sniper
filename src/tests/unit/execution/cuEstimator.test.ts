/**
 * Unit tests for execution/tx/cuEstimator.ts
 *
 * Tests dynamic compute unit estimation:
 *   - Default fallback when insufficient samples
 *   - Rolling average with 20% buffer after 5+ samples
 *   - Window size limits (max 20 samples)
 *   - Clamping to [100_000, 1_400_000]
 *   - Separate tracking per transaction type
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

    it('uses rolling average * 1.2 after 5 samples', () => {
      const estimator = new CUEstimator();
      // Record 5 samples of exactly 100,000 CU
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // Expected: ceil(100_000 * 1.2) = 120_000
      expect(estimator.estimateCu('BUY')).toBe(120_000);
    });

    it('calculates rolling average correctly with varying samples', () => {
      const estimator = new CUEstimator();
      // 5 samples: 100k, 200k, 150k, 180k, 120k → avg = 150k
      estimator.recordActualCu('BUY', 100_000);
      estimator.recordActualCu('BUY', 200_000);
      estimator.recordActualCu('BUY', 150_000);
      estimator.recordActualCu('BUY', 180_000);
      estimator.recordActualCu('BUY', 120_000);
      // avg = 150,000 → 150,000 * 1.2 = 180,000
      expect(estimator.estimateCu('BUY')).toBe(180_000);
    });

    it('clamps to minimum 100,000 CU', () => {
      const estimator = new CUEstimator();
      // 5 very small samples: avg = 50,000 → 50k * 1.2 = 60,000 → clamped to 100,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 50_000);
      }
      expect(estimator.estimateCu('BUY')).toBe(100_000);
    });

    it('clamps to maximum 1,400,000 CU', () => {
      const estimator = new CUEstimator();
      // 5 very large samples: avg = 1,300,000 → 1.3M * 1.2 = 1,560,000 → clamped to 1,400,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 1_300_000);
      }
      expect(estimator.estimateCu('BUY')).toBe(1_400_000);
    });

    it('tracks BUY and SELL independently', () => {
      const estimator = new CUEstimator();
      // BUY: 5 samples of 100k → estimate = 120k
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // SELL: 5 samples of 200k → estimate = 240k
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

    it('maintains a rolling window of max 20 samples', () => {
      const estimator = new CUEstimator();
      // Record 25 samples
      for (let i = 0; i < 25; i++) {
        estimator.recordActualCu('BUY', 100_000 + i * 1000);
      }
      // Should cap at 20
      expect(estimator.sampleCount('BUY')).toBe(20);
    });

    it('drops oldest samples when window is full', () => {
      const estimator = new CUEstimator();
      // Fill window with 20 samples of 100,000
      for (let i = 0; i < 20; i++) {
        estimator.recordActualCu('BUY', 100_000);
      }
      // Add 5 more samples of 200,000
      for (let i = 0; i < 5; i++) {
        estimator.recordActualCu('BUY', 200_000);
      }
      // Window is 20: 15 samples of 100k + 5 samples of 200k
      // avg = (15 * 100,000 + 5 * 200,000) / 20 = 2,500,000 / 20 = 125,000
      // estimate = ceil(125,000 * 1.2) = 150,000
      expect(estimator.estimateCu('BUY')).toBe(150_000);
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
