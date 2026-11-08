/** Regression for global ticket 1787: correct label-set payload + verified writes. */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { updateTask } from '../../../src/tools/tasks/crud/TaskUpdateService';
import { bulkUpdateTasks } from '../../../src/tools/tasks/bulk-operations';
import { applyLabels, removeLabels } from '../../../src/tools/tasks/labels';
import { getClientFromContext } from '../../../src/client';
import { withRetry } from '../../../src/utils/retry';

jest.mock('../../../src/client');
jest.mock('../../../src/utils/retry', () => ({
  ...jest.requireActual('../../../src/utils/retry'),
  withRetry: jest.fn(),
}));
jest.mock('../../../src/utils/logger');

describe('Verified label replacement and removal (global ticket 1787)', () => {
  let serverLabels: Map<number, number[]>;
  const mockClient = {
    tasks: {
      getTask: jest.fn(),
      updateTask: jest.fn(),
      request: jest.fn(),
      addLabelToTask: jest.fn(),
      removeLabelFromTask: jest.fn(),
      updateTaskLabels: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    serverLabels = new Map([[1763, [2, 7]]]);
    (getClientFromContext as jest.Mock).mockResolvedValue(mockClient);
    (withRetry as jest.Mock).mockImplementation((fn: () => Promise<unknown>) => fn());
    mockClient.tasks.getTask.mockImplementation(async (id: number) => ({
      id, title: `Task ${id}`, project_id: 1, description: 'keep me', priority: 4,
      labels: (serverLabels.get(id) ?? []).map((labelId) => ({
        id: labelId, title: `label-${labelId}`,
      })),
    }));
    // Updating the task model does not change label relationships.
    mockClient.tasks.updateTask.mockImplementation(async (_id: number, data: unknown) => data);
    mockClient.tasks.request.mockImplementation(
      async (path: string, method: string, body: { labels: Array<{ id: number }> }) => {
        expect(method).toBe('POST');
        expect(body).toEqual({ labels: expect.any(Array) });
        const match = /^\/tasks\/(\d+)\/labels\/bulk$/.exec(path);
        expect(match).not.toBeNull();
        const ids = body.labels.map((label) => {
          expect(label).toEqual({ id: expect.any(Number) });
          return label.id;
        });
        serverLabels.set(Number(match?.[1]), ids);
        return {};
      },
    );
    mockClient.tasks.addLabelToTask.mockImplementation(
      async (id: number, body: { label_id: number }) => {
        serverLabels.set(id, [...(serverLabels.get(id) ?? []), body.label_id]);
        return {};
      },
    );
    mockClient.tasks.removeLabelFromTask.mockRejectedValue(new Error('DELETE failed'));
    mockClient.tasks.updateTaskLabels.mockRejectedValue(new Error('wrong payload'));
  });

  it.each([{ ids: [2] }, { ids: [6] }, { ids: [] }, { ids: [7, 2, 2] }])(
    'update replaces labels with $ids', async ({ ids }) => {
      await updateTask({ id: 1763, labels: ids });
      expect(serverLabels.get(1763)).toEqual([...new Set(ids)]);
      expect(mockClient.tasks.updateTaskLabels).not.toHaveBeenCalled();
      expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(1763, expect.objectContaining({
        description: 'keep me', priority: 4,
      }));
    },
  );

  it('omission preserves labels while apply-label remains additive', async () => {
    await updateTask({ id: 1763, title: 'Title only' });
    expect(mockClient.tasks.request).not.toHaveBeenCalled();
    await applyLabels({ id: 1763, labels: [2, 6] });
    expect(serverLabels.get(1763)).toEqual([2, 7, 6]);
  });

  it('remove-label keeps unrequested labels and tolerates duplicates and absent IDs', async () => {
    await removeLabels({ id: 1763, labels: [7, 7, 99] });
    expect(serverLabels.get(1763)).toEqual([2]);
    expect(mockClient.tasks.request).toHaveBeenCalledWith(
      '/tasks/1763/labels/bulk', 'POST', { labels: [{ id: 2 }] },
    );
    expect(mockClient.tasks.removeLabelFromTask).not.toHaveBeenCalled();
    await removeLabels({ id: 1763, labels: [2] });
    expect(serverLabels.get(1763)).toEqual([]);
  });

  it('bulk-update replaces each set and returns verified labels, not stale snapshots', async () => {
    serverLabels.set(1764, [6]);
    const result = await bulkUpdateTasks({ taskIds: [1763, 1764], field: 'labels', value: [2] });
    expect(serverLabels.get(1763)).toEqual([2]);
    expect(serverLabels.get(1764)).toEqual([2]);
    expect(mockClient.tasks.updateTask).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Successfully updated 2 tasks');
    expect(result.content[0].text).not.toContain('label-7');
    expect(result.content[0].text).not.toContain('label-6');
    await bulkUpdateTasks({ taskIds: [1763, 1764], field: 'labels', value: [] });
    expect(serverLabels.get(1763)).toEqual([]);
    expect(serverLabels.get(1764)).toEqual([]);
  });

  it('rejects silent no-op responses for update, removal and bulk-update', async () => {
    mockClient.tasks.request.mockResolvedValue({});
    await expect(updateTask({ id: 1763, labels: [2] })).rejects.toThrow('was not applied');
    await expect(removeLabels({ id: 1763, labels: [7] })).rejects.toThrow('was not applied');
    await expect(bulkUpdateTasks({ taskIds: [1763], field: 'labels', value: [2] }))
      .rejects.toThrow('Failed IDs: 1763');
  });

  it('reports partial bulk failure when one write silently does nothing', async () => {
    mockClient.tasks.request.mockResolvedValueOnce({});
    const result = await bulkUpdateTasks({ taskIds: [1763, 1764], field: 'labels', value: [2] });
    expect(result.content[0].text).toContain('Successfully updated 1 tasks, 1 failed');
    expect(result.content[0].text).toContain('1763');
    expect(result.content[0].text).toContain('Error');
  });

  it('rejects a wrong label set even when the label count matches', async () => {
    serverLabels.set(1763, [2]);
    mockClient.tasks.request.mockResolvedValue({});
    await expect(updateTask({ id: 1763, labels: [6] })).rejects.toThrow('was not applied');
  });

  it.each([401, 403])('reports required token permission on HTTP %i', async (status) => {
    const error = Object.assign(new Error('Forbidden'), { status });
    mockClient.tasks.request.mockRejectedValue(error);
    await expect(removeLabels({ id: 1763, labels: [7] }))
      .rejects.toThrow('permission for POST /tasks/{id}/labels/bulk');
    expect(serverLabels.get(1763)).toEqual([2, 7]);
    const options = (withRetry as jest.Mock).mock.calls[0]?.[1] as {
      shouldRetry: (error: Error) => boolean;
    };
    expect(options.shouldRetry(error)).toBe(false);
  });

  it('validates label IDs before mutating a task', async () => {
    await expect(updateTask({ id: 1763, labels: [0] })).rejects.toThrow('positive integer');
    expect(mockClient.tasks.updateTask).not.toHaveBeenCalled();
    expect(mockClient.tasks.request).not.toHaveBeenCalled();
  });
});
