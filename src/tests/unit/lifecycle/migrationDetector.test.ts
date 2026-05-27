import { describe, expect, it, vi } from 'vitest';
import { MigrationSignalDetector } from '../../../detectors/lifecycle/migrationDetector.js';
import type { MintAddress } from '../../../core/types/token.js';

const MIGRATION_LOGS = ['Program log: Instruction: Migrate'];
const VALID_MINT = '9k4hSLZoGcHcUYR3gHscyFPoVKUxMLhtcZiFQMD2pump' as MintAddress;

describe('MigrationSignalDetector', () => {
  it('does not emit migration signals with empty/invalid mint', async () => {
    const detector = new MigrationSignalDetector();
    const handler = vi.fn();
    detector.onSignal(handler);
    await detector.start();

    detector.handleTransaction({
      mint: '' as MintAddress,
      logs: MIGRATION_LOGS,
      slot: 123,
      signature: 'sig-empty-mint',
    });

    expect(handler).not.toHaveBeenCalled();
    await detector.stop();
  });

  it('emits migration signals when logs and mint are valid', async () => {
    const detector = new MigrationSignalDetector();
    const handler = vi.fn();
    detector.onSignal(handler);
    await detector.start();

    detector.handleTransaction({
      mint: VALID_MINT,
      logs: MIGRATION_LOGS,
      slot: 123,
      signature: 'sig-valid-mint',
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]?.mint).toBe(VALID_MINT);
    await detector.stop();
  });
});
