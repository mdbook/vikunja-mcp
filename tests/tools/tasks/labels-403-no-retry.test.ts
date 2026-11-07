/** Real retry regression: absence is read, never inferred from a permission error. */
import { removeLabels } from '../../../src/tools/tasks/labels';
import { getClientFromContext } from '../../../src/client';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

jest.mock('../../../src/client');

const mockGetClientFromContext = jest.mocked(getClientFromContext);

describe('removeLabels - verified absence and honest authorization errors', () => {
  const mockClient = {
    tasks: {
      request: jest.fn(),
      removeLabelFromTask: jest.fn(),
      getTask: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetClientFromContext.mockResolvedValue(mockClient as any);
    circuitBreakerRegistry.clear();
    mockClient.tasks.getTask.mockResolvedValue({
      id: 1, title: 'Test Task', labels: [{ id: 5 }],
    });
  });

  it.each([{ labels: [] }, { labels: [{ id: 7 }] }, { labels: null }])(
    'reads an already-absent label as a no-op without any write ($labels)', async ({ labels }) => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Test Task', labels });

      const result = await removeLabels({ id: 1, labels: [5] });

      expect(result.content[0].text).toContain('already absent');
      expect(mockClient.tasks.request).not.toHaveBeenCalled();
      expect(mockClient.tasks.removeLabelFromTask).not.toHaveBeenCalled();
      expect(circuitBreakerRegistry.getAllStatsSync()).toEqual({});
    },
  );

  it.each([401, 403])(
    'does not swallow or retry a real node-vikunja-shaped HTTP %i', async (statusCode) => {
      const error = Object.assign(new Error(
        'Label operation failed due to authentication issue. Original error: You do not have the right to see this',
      ), {
        name: 'LabelAuthenticationError',
        statusCode,
        response: { message: 'You do not have the right to see this', code: 'kg.forbidden' },
      });
      mockClient.tasks.request.mockRejectedValue(error);

      await expect(removeLabels({ id: 1, labels: [5] }))
        .rejects.toThrow('permission for POST /tasks/{id}/labels/bulk');

      expect(mockClient.tasks.request).toHaveBeenCalledTimes(1);
      expect(mockClient.tasks.removeLabelFromTask).not.toHaveBeenCalled();
      // Label-set writes do not touch the shared auth circuit breaker.
      expect(circuitBreakerRegistry.getAllStatsSync()).toEqual({});
    },
  );

  it('does not infer absence from a message-only forbidden error', async () => {
    mockClient.tasks.request.mockRejectedValue(new Error('forbidden'));

    await expect(removeLabels({ id: 1, labels: [5] })).rejects.toThrow('authorization failed');
    expect(mockClient.tasks.request).toHaveBeenCalledTimes(1);
  });

  it('retries transient label-set failures and verifies the final state', async () => {
    mockClient.tasks.request
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { statusCode: 500 }))
      .mockResolvedValue({});
    mockClient.tasks.getTask
      .mockResolvedValueOnce({ id: 1, title: 'Test Task', labels: [{ id: 5 }] })
      .mockResolvedValue({ id: 1, title: 'Test Task', labels: [] });

    const result = await removeLabels({ id: 1, labels: [5] });

    expect(result.content[0].text).toContain('Label removed from task successfully');
    expect(mockClient.tasks.request).toHaveBeenCalledTimes(2);
    expect(circuitBreakerRegistry.getAllStatsSync()).toEqual({});
  });
});
