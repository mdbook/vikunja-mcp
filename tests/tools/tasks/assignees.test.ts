/**
 * Tests for assignee operations
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { assignUsers, unassignUsers, listAssignees } from '../../../src/tools/tasks/assignees';
import {
  findMissingAssigneeIds,
  AssigneeOperationsService,
} from '../../../src/tools/tasks/assignees/AssigneeOperationsService';
import { getClientFromContext } from '../../../src/client';
import { MCPError, ErrorCode } from '../../../src/types';
import { isAuthenticationError, isRetryableAuthError } from '../../../src/utils/auth-error-handler';
import { withRetry, getHttpStatus } from '../../../src/utils/retry';
import { parseMarkdown } from '../../utils/markdown';

jest.mock('../../../src/client');
jest.mock('../../../src/utils/auth-error-handler');
jest.mock('../../../src/utils/retry');
jest.mock('../../../src/utils/logger');

describe('Assignee operations', () => {
  describe('findMissingAssigneeIds', () => {
    it('returns ids not present on the task', () => {
      expect(findMissingAssigneeIds([{ id: 1 }], [1, 2])).toEqual([2]);
      expect(findMissingAssigneeIds(undefined, [1])).toEqual([1]);
      expect(findMissingAssigneeIds([{ id: 1 }, { id: undefined }], [1])).toEqual([]);
    });
  });

  const mockClient = {
    tasks: {
      assignUserToTask: jest.fn(),
      removeUserFromTask: jest.fn(),
      getTask: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getClientFromContext as jest.Mock).mockResolvedValue(mockClient);
    (isAuthenticationError as jest.Mock).mockReturnValue(false);
    (isRetryableAuthError as jest.Mock).mockReturnValue(false);
    (withRetry as jest.Mock).mockImplementation((fn) => fn());
  });

  describe('assignUsers', () => {
    it('should assign users to task successfully', async () => {
      const mockTaskEmpty = {
        id: 123,
        title: 'Test Task',
        assignees: [],
      };
      const mockTask = {
        id: 123,
        title: 'Test Task',
        assignees: [{ id: 1, name: 'User 1' }, { id: 2, name: 'User 2' }],
      };
      
      mockClient.tasks.assignUserToTask.mockResolvedValue({});
      // First getTask: current assignees before add; later: verify/fetch
      mockClient.tasks.getTask
        .mockResolvedValueOnce(mockTaskEmpty)
        .mockResolvedValue(mockTask);

      const result = await assignUsers({
        id: 123,
        assignees: [1, 2],
      });

      expect(mockClient.tasks.assignUserToTask).toHaveBeenCalledWith(123, 1);
      expect(mockClient.tasks.assignUserToTask).toHaveBeenCalledWith(123, 2);
      expect(mockClient.tasks.getTask).toHaveBeenCalledWith(123);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('assign');
      expect(markdown).toContain('Users assigned to task successfully');
    });

    it('should warn when assignees are not persisted (silent API failure)', async () => {
      // Simulate the API accepting the assign call but not persisting assignees
      const mockTaskNoAssignees = {
        id: 123,
        title: 'Test Task',
        assignees: [],
      };

      mockClient.tasks.assignUserToTask.mockResolvedValue({});
      mockClient.tasks.getTask.mockResolvedValue(mockTaskNoAssignees);

      const result = await assignUsers({
        id: 123,
        assignees: [1, 2],
      });

      const markdown = result.content[0].text;
      expect(markdown).toContain('not persisted');
      expect(markdown).toContain('silent no-op');
    });

    it('verifyAssignees fails open when re-fetch throws', async () => {
      mockClient.tasks.getTask.mockRejectedValue(new Error('network'));
      await expect(
        AssigneeOperationsService.verifyAssignees(123, [1]),
      ).resolves.toEqual([]);
    });

    it('should throw error when task id is missing', async () => {
      await expect(assignUsers({ assignees: [1, 2] })).rejects.toThrow(
        'Task id is required for assign operation'
      );
    });

    it('should throw error when task id is zero', async () => {
      await expect(assignUsers({ id: 0, assignees: [1, 2] })).rejects.toThrow(
        'Task id is required for assign operation'
      );
    });

    it('should throw error when task id is negative', async () => {
      await expect(assignUsers({ id: -1, assignees: [1, 2] })).rejects.toThrow(
        'id must be a positive integer'
      );
    });

    it('should throw error when assignees array is missing', async () => {
      await expect(assignUsers({ id: 123 })).rejects.toThrow(
        'At least one assignee (user id) is required'
      );
    });

    it('should throw error when assignees array is empty', async () => {
      await expect(assignUsers({ id: 123, assignees: [] })).rejects.toThrow(
        'At least one assignee (user id) is required'
      );
    });

    it('should throw error when assignee id is invalid', async () => {
      await expect(assignUsers({ id: 123, assignees: [1, -2] })).rejects.toThrow(
        'assignee ID must be a positive integer'
      );
    });

    it('should handle authentication errors with retry (401 — retryable, retried and exhausted)', async () => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 123, title: 'T', assignees: [] });
      const authError = new Error('Authentication failed');
      (isAuthenticationError as jest.Mock).mockReturnValue(true);
      (isRetryableAuthError as jest.Mock).mockReturnValue(true);
      (withRetry as jest.Mock).mockRejectedValue(authError);
      (getHttpStatus as jest.Mock).mockReturnValue(401);

      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        "Failed to assign users to task: Vikunja refused to assign the user(s) to the task. The service token may lack permission for this task, or the user may not have access to the task's project. Vikunja returned HTTP 401: Authentication failed (Retried 3 times)"
      );
      // The old misleading "known limitation" text must be gone.
      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.not.toThrow(/known limitation/);
    });

    it('surfaces the Vikunja server body message when it differs from the error message', async () => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 123, title: 'T', assignees: [] });
      const forbidden = new Error('Request failed') as Error & {
        statusCode: number;
        response: { message: string; code: number };
      };
      forbidden.statusCode = 403;
      forbidden.response = { message: 'Forbidden', code: 403 };
      (isAuthenticationError as jest.Mock).mockReturnValue(true);
      (isRetryableAuthError as jest.Mock).mockReturnValue(false);
      (withRetry as jest.Mock).mockRejectedValue(forbidden);
      (getHttpStatus as jest.Mock).mockReturnValue(403);

      await expect(assignUsers({ id: 123, assignees: [1] })).rejects.toThrow(
        'Vikunja returned HTTP 403: Request failed (server: Forbidden)'
      );
    });

    it('should fail fast with an honest message for a non-retryable auth error (403 — permanent permission denial)', async () => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 123, title: 'T', assignees: [] });
      // .statusCode is the shape real node-vikunja errors actually carry the status on
      // (not bare .status) — see auth-error-handler.ts's isRetryableAuthError doc.
      const forbidden = new Error('Forbidden') as Error & { statusCode: number };
      forbidden.statusCode = 403;
      (isAuthenticationError as jest.Mock).mockReturnValue(true);
      (isRetryableAuthError as jest.Mock).mockReturnValue(false);
      (withRetry as jest.Mock).mockRejectedValue(forbidden);
      // getHttpStatus (from retry.ts, auto-mocked in this file) backs the honest
      // "HTTP <status>" message; wire it to reflect the injected error's real status.
      (getHttpStatus as jest.Mock).mockReturnValue(403);

      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        'Failed to assign users to task: Vikunja refused to assign the user(s) to the task. The service token may lack permission for this task, or the user may not have access to the task\'s project. Vikunja returned HTTP 403: Forbidden'
      );
      // Must NOT claim a retry that never happened.
      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.not.toThrow(/Retried/);
    });

    it('should handle non-authentication API errors', async () => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 123, title: 'T', assignees: [] });
      const apiError = new Error('API Error');
      (withRetry as jest.Mock).mockRejectedValue(apiError);

      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        'Failed to assign users to task: API Error'
      );
    });

    it('should handle unknown error types', async () => {
      mockClient.tasks.getTask.mockResolvedValue({ id: 123, title: 'T', assignees: [] });
      const unknownError = { message: 'Unknown error' };
      (withRetry as jest.Mock).mockRejectedValue(unknownError);

      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        'Failed to assign users to task: [object Object]'
      );
    });

    it('should handle MCPError instances properly', async () => {
      const mcpError = new MCPError(ErrorCode.VALIDATION_ERROR, 'Validation failed');
      mockClient.tasks.getTask.mockRejectedValue(mcpError);

      await expect(assignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        'Failed to assign users to task: Validation failed'
      );
    });
  });

  describe('unassignUsers', () => {
    it('should unassign users from task successfully', async () => {
      const mockTask = {
        id: 123,
        title: 'Test Task',
        assignees: [],
      };
      
      mockClient.tasks.removeUserFromTask.mockResolvedValue({});
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await unassignUsers({
        id: 123,
        assignees: [1, 2],
      });

      expect(mockClient.tasks.removeUserFromTask).toHaveBeenCalledTimes(2);
      expect(mockClient.tasks.removeUserFromTask).toHaveBeenCalledWith(123, 1);
      expect(mockClient.tasks.removeUserFromTask).toHaveBeenCalledWith(123, 2);
      expect(mockClient.tasks.getTask).toHaveBeenCalledWith(123);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('unassign');
      expect(markdown).toContain('Users removed from task successfully');
    });

    it('should throw error when task id is missing', async () => {
      await expect(unassignUsers({ assignees: [1, 2] })).rejects.toThrow(
        'Task id is required for unassign operation'
      );
    });

    it('should throw error when task id is zero', async () => {
      await expect(unassignUsers({ id: 0, assignees: [1, 2] })).rejects.toThrow(
        'Task id is required for unassign operation'
      );
    });

    it('should throw error when assignees array is missing', async () => {
      await expect(unassignUsers({ id: 123 })).rejects.toThrow(
        'At least one assignee (user id) is required to unassign'
      );
    });

    it('should throw error when assignees array is empty', async () => {
      await expect(unassignUsers({ id: 123, assignees: [] })).rejects.toThrow(
        'At least one assignee (user id) is required to unassign'
      );
    });

    it('should handle authentication errors during removal (401 — retryable, retried and exhausted)', async () => {
      const authError = new Error('Authentication failed');
      (isAuthenticationError as jest.Mock).mockReturnValue(true);
      (isRetryableAuthError as jest.Mock).mockReturnValue(true);
      (withRetry as jest.Mock).mockRejectedValue(authError);
      (getHttpStatus as jest.Mock).mockReturnValue(401);

      await expect(unassignUsers({ id: 123, assignees: [1] })).rejects.toThrow(
        'Failed to remove users from task: Vikunja refused to remove the user(s) from the task. The service token may lack permission for this task. Vikunja returned HTTP 401: Authentication failed (Retried 3 times)'
      );
      await expect(unassignUsers({ id: 123, assignees: [1] })).rejects.not.toThrow(/known limitation/);
    });

    it('should fail fast with an honest message during removal for a non-retryable auth error (403)', async () => {
      const forbidden = new Error('Forbidden') as Error & { statusCode: number };
      forbidden.statusCode = 403;
      (isAuthenticationError as jest.Mock).mockReturnValue(true);
      (isRetryableAuthError as jest.Mock).mockReturnValue(false);
      (withRetry as jest.Mock).mockRejectedValue(forbidden);
      (getHttpStatus as jest.Mock).mockReturnValue(403);

      await expect(unassignUsers({ id: 123, assignees: [1] })).rejects.toThrow(
        'Failed to remove users from task: Vikunja refused to remove the user(s) from the task. The service token may lack permission for this task. Vikunja returned HTTP 403: Forbidden'
      );
      await expect(unassignUsers({ id: 123, assignees: [1] })).rejects.not.toThrow(/Retried/);
    });

    it('should handle non-authentication errors during removal', async () => {
      const apiError = new Error('API Error');
      (withRetry as jest.Mock).mockRejectedValue(apiError);

      await expect(unassignUsers({ id: 123, assignees: [1] })).rejects.toThrow(
        'Failed to remove users from task: API Error'
      );
    });

    it('should handle mixed success and failure during batch removal', async () => {
      const apiError = new Error('User not found');
      (withRetry as jest.Mock)
        .mockResolvedValueOnce({}) // First user succeeds
        .mockRejectedValueOnce(apiError); // Second user fails

      await expect(unassignUsers({ id: 123, assignees: [1, 2] })).rejects.toThrow(
        'Failed to remove users from task: User not found'
      );

      // Verify that at least the first removal was attempted
      expect(withRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe('listAssignees', () => {
    it('should list assignees successfully', async () => {
      const mockTask = {
        id: 123,
        title: 'Test Task',
        assignees: [
          { id: 1, name: 'User 1' },
          { id: 2, name: 'User 2' },
        ],
      };
      
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await listAssignees({ id: 123 });

      expect(mockClient.tasks.getTask).toHaveBeenCalledWith(123);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('get');
      expect(markdown).toContain('Task has 2 assignee(s)');
    });

    it('should handle task with no assignees', async () => {
      const mockTask = {
        id: 123,
        title: 'Test Task',
        assignees: [],
      };
      
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await listAssignees({ id: 123 });

      const markdown = result.content[0].text;
      expect(markdown).toContain('Task has 0 assignee(s)');
    });

    it('should handle task with undefined assignees', async () => {
      const mockTask = {
        id: 123,
        title: 'Test Task',
        // assignees is undefined
      };
      
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await listAssignees({ id: 123 });

      const markdown = result.content[0].text;
      expect(markdown).toContain('Task has 0 assignee(s)');
    });

    it('should throw error when task id is undefined', async () => {
      await expect(listAssignees({})).rejects.toThrow(
        'Task id is required for list-assignees operation'
      );
    });

    it('should handle zero task id', async () => {
      await expect(listAssignees({ id: 0 })).rejects.toThrow(
        'id must be a positive integer'
      );
    });

    it('should handle negative task id', async () => {
      await expect(listAssignees({ id: -1 })).rejects.toThrow(
        'id must be a positive integer'
      );
    });

    it('should handle API errors', async () => {
      const apiError = new Error('Task not found');
      mockClient.tasks.getTask.mockRejectedValue(apiError);

      await expect(listAssignees({ id: 123 })).rejects.toThrow(
        'Failed to list task assignees: Task not found'
      );
    });

    it('should preserve MCPError instances', async () => {
      const mcpError = new MCPError(ErrorCode.NOT_FOUND, 'Task not found');
      mockClient.tasks.getTask.mockRejectedValue(mcpError);

      await expect(listAssignees({ id: 123 })).rejects.toThrow(mcpError);
    });

    it('should handle unknown error types', async () => {
      const unknownError = { status: 'error' };
      mockClient.tasks.getTask.mockRejectedValue(unknownError);

      await expect(listAssignees({ id: 123 })).rejects.toThrow(
        'Failed to list task assignees: [object Object]'
      );
    });

    it('should handle task with undefined id in response', async () => {
      const mockTask = {
        // id is undefined
        title: 'Test Task',
        assignees: [{ id: 1, name: 'User 1' }],
      };
      
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      await expect(listAssignees({ id: 123 })).rejects.toThrow(
        'Task returned from API is missing required id field'
      );
    });
  });

  // Integration tests
  describe('Integration scenarios', () => {
    it('should handle complete assign-unassign workflow', async () => {
      const initialTask = {
        id: 123,
        title: 'Test Task',
        assignees: [],
      };
      
      const assignedTask = {
        id: 123,
        title: 'Test Task',
        assignees: [{ id: 1, name: 'User 1' }],
      };
      
      // Mock assignment — first getTask is current (empty), later fetch shows assigned
      mockClient.tasks.assignUserToTask.mockResolvedValue({});
      mockClient.tasks.getTask
        .mockResolvedValueOnce(initialTask)
        .mockResolvedValue(assignedTask);
      
      const assignResult = await assignUsers({ id: 123, assignees: [1] });

      const assignMarkdown = assignResult.content[0].text;
      expect(assignMarkdown).toContain('Users assigned to task successfully');

      // Mock unassignment
      mockClient.tasks.removeUserFromTask.mockResolvedValue({});
      mockClient.tasks.getTask.mockResolvedValue(initialTask);

      const unassignResult = await unassignUsers({ id: 123, assignees: [1] });

      const unassignMarkdown = unassignResult.content[0].text;
      expect(unassignMarkdown).toContain('Users removed from task successfully');
    });

    it('should handle multiple assignees with mixed validation errors', async () => {
      await expect(assignUsers({ 
        id: 123, 
        assignees: [1, 0, -1] // Mix of valid and invalid IDs
      })).rejects.toThrow('assignee ID must be a positive integer');
    });
  });
});