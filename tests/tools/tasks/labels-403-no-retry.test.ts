/**
 * Regression test for #309: a 403 from `DELETE /tasks/{id}/labels/{labelId}` was
 * originally suspected to be a missing service-token scope, treated as a retryable
 * auth error, retried 3x, and hammered the shared `vikunja-auth-connect` circuit
 * breaker until it opened and blocked apply-label too.
 *
 * A controlled experiment (confirmed 2x) found the real cause: Vikunja's label-remove
 * is NOT idempotent — removing a label that IS on the task returns 200, removing one
 * that is NOT on the task (already absent) returns 403. So for `removeLabels`, a 403
 * means the desired end state is already reached: it must be a benign no-op success,
 * not an error, and it must never be retried into the shared breaker either way.
 *
 * Unlike tests/tools/tasks/labels.test.ts, this file does NOT mock `../../src/utils/retry`
 * — it needs the real `withRetry` + `shouldRetry` gate to prove the call count.
 */
import { removeLabels } from '../../../src/tools/tasks/labels';
import { getClientFromContext } from '../../../src/client';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

jest.mock('../../../src/client');

const mockGetClientFromContext = jest.mocked(getClientFromContext);

describe('removeLabels - 403 is a benign idempotent no-op (no retry, no breaker hammering)', () => {
  const mockClient = {
    tasks: {
      removeLabelFromTask: jest.fn(),
      getTask: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockGetClientFromContext.mockResolvedValue(mockClient as any);
    // Circuit breakers are module-level singletons keyed by name; reset between tests
    // so a prior test's failures don't leave the shared breaker open.
    await circuitBreakerRegistry.resetAll();
  });

  it('succeeds (does not throw) when the label is already absent (403), calling removeLabelFromTask exactly once', async () => {
    const forbidden = new Error('Forbidden') as Error & { status: number };
    forbidden.status = 403;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(forbidden);
    mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    const result = await removeLabels({ id: 1, labels: [5] });

    // Only one attempt — a 403 must not be retried, regardless of how it's interpreted.
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('already absent');
  });

  it('treats a lowercase/message-only "forbidden" the same way', async () => {
    const forbidden = new Error('forbidden');
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(forbidden);
    mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    await expect(removeLabels({ id: 1, labels: [5] })).resolves.toBeDefined();
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
  });

  it('still fails fast (no retry) and surfaces an honest error for a genuinely different non-auth error', async () => {
    const serverError = new Error('Internal Server Error') as Error & { status: number };
    serverError.status = 500;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(serverError);

    await expect(removeLabels({ id: 1, labels: [5] })).rejects.toThrow(/Internal Server Error/);
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
  });
});
