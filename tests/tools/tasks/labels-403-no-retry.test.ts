/**
 * Regression test for the #309 breaker flap: a permanent 403 (the Vikunja service
 * token lacking permission) was treated as a retryable auth error, retried 3x, and
 * hammered the shared `vikunja-auth-connect` circuit breaker until it opened and
 * blocked apply-label too. A 403 must fail fast (one attempt) with an honest message.
 *
 * Unlike tests/tools/tasks/labels.test.ts, this file does NOT mock `../../src/utils/retry`
 * — it needs the real `withRetry` + `shouldRetry` gate to prove the call count.
 */
import { removeLabels } from '../../../src/tools/tasks/labels';
import { getClientFromContext } from '../../../src/client';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

jest.mock('../../../src/client');

const mockGetClientFromContext = jest.mocked(getClientFromContext);

describe('removeLabels - 403 fails fast (no retry, no breaker hammering)', () => {
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

  it('calls removeLabelFromTask exactly once on a 403 and surfaces an honest message', async () => {
    const forbidden = new Error('Forbidden') as Error & { status: number };
    forbidden.status = 403;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(forbidden);

    await expect(removeLabels({ id: 1, labels: [5] })).rejects.toThrow(
      /403.*permission/i,
    );

    // Only one attempt — a permanent 403 must not be retried.
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
    // The task was never re-fetched because the operation failed.
    expect(mockClient.tasks.getTask).not.toHaveBeenCalled();
  });
});
