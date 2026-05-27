import { describe, expect, it } from 'vitest';
import { runPipelineTests } from './pipelineIntegrationTest.js';

describe('runPipelineTests', () => {
  it('runs the full pipeline integration harness under Vitest', async () => {
    const result = await runPipelineTests();

    expect(result.passed).toBe(true);
    expect(result.testsRun).toBe(10);
    expect(result.testsFailed).toBe(0);
  });
});
