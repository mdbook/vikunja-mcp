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
    // Circuit breakers are module-level singletons keyed by name (`vikunja-auth-connect`
    // here) and every test in this file hits the SAME named breaker. `resetAll()` only
    // closes an already-open breaker — it does not clear its accumulated failure stats —
    // so failures from earlier tests would otherwise carry over and trip the breaker open
    // for a later test. `clear()` fully unregisters every breaker so each test starts
    // against a genuinely fresh one.
    circuitBreakerRegistry.clear();
  });

  it('succeeds (does not throw) when the label is already absent (403 via .statusCode), calling removeLabelFromTask exactly once', async () => {
    // .statusCode is the shape a plain/generic error carries it on in this suite's
    // simplest form. The next test covers the REAL node-vikunja LabelAuthenticationError
    // shape, whose message doesn't say "forbidden" at all.
    const forbidden = new Error('Forbidden') as Error & { statusCode: number };
    forbidden.statusCode = 403;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(forbidden);
    mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    const result = await removeLabels({ id: 1, labels: [5] });

    // Only one attempt — a 403 must not be retried, regardless of how it's interpreted.
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('already absent');
  });

  it('succeeds as a no-op for a REAL node-vikunja LabelAuthenticationError shape (.statusCode 403, wrapped message WITHOUT the word "forbidden")', async () => {
    // This is exactly what node-vikunja's removeLabelFromTask throws in prod: a
    // LabelAuthenticationError with the real HTTP status on `.statusCode` (NOT `.status`
    // or `.response.status` — `.response` there is the JSON body `{message, code}`), and
    // a message that wraps the body without necessarily containing "forbidden". Before
    // the statusCode-based fix, 403 detection depended entirely on the message containing
    // "forbidden" and this case would have fallen through as a genuine (and wrong) error.
    const labelAuthError = new Error(
      'Label operation failed due to authentication issue. Original error: You do not have the right to see this',
    ) as Error & { statusCode: number; response: { message: string; code: string } };
    labelAuthError.name = 'LabelAuthenticationError';
    labelAuthError.statusCode = 403;
    labelAuthError.response = { message: 'You do not have the right to see this', code: 'kg.forbidden' };
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(labelAuthError);
    mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    const result = await removeLabels({ id: 1, labels: [5] });

    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('already absent');
  });

  it('treats a lowercase/message-only "forbidden" the same way (fallback path, no structured status)', async () => {
    const forbidden = new Error('forbidden');
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(forbidden);
    mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    await expect(removeLabels({ id: 1, labels: [5] })).resolves.toBeDefined();
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
  });

  it('still fails fast (no retry) and surfaces an honest error for a genuinely different non-auth error', async () => {
    const serverError = new Error('Internal Server Error') as Error & { statusCode: number };
    serverError.statusCode = 500;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(serverError);

    await expect(removeLabels({ id: 1, labels: [5] })).rejects.toThrow(/Internal Server Error/);
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(1);
  });

  it('still retries a real node-vikunja-shaped 401 (statusCode) and reports honestly once exhausted', async () => {
    // Real timers on purpose: RETRY_CONFIG.AUTH_ERRORS' actual backoff (1000/2000/4000ms)
    // runs for real here, so this proves the full retry loop end-to-end rather than
    // fighting fake-timer/circuit-breaker interaction for a ~7s saving.
    const unauthorized = new Error(
      'Authentication failed. Original error: token expired',
    ) as Error & { statusCode: number };
    unauthorized.name = 'VikunjaAuthenticationError';
    unauthorized.statusCode = 401;
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(unauthorized);

    await expect(removeLabels({ id: 1, labels: [5] })).rejects.toThrow(/Retried 3 times/);

    // maxRetries: 3 -> 4 total attempts (initial + 3 retries).
    expect(mockClient.tasks.removeLabelFromTask).toHaveBeenCalledTimes(4);
  }, 15000);
});
