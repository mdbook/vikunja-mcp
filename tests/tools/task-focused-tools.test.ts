/**
 * Registration/handler coverage for focused task tools.
 * Underlying domain logic is covered elsewhere; these tests exercise
 * auth gates, client wiring, and operation routing.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../../src/auth/AuthManager';
import type { VikunjaClientFactory } from '../../src/client/VikunjaClientFactory';
import { z } from 'zod';
import { MCPError, ErrorCode } from '../../src/types';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/tools/tasks/assignees/index', () => ({
  assignUsers: jest.fn(async () => ({ content: [{ type: 'text', text: 'assigned' }] })),
  unassignUsers: jest.fn(async () => ({ content: [{ type: 'text', text: 'unassigned' }] })),
  listAssignees: jest.fn(async () => ({ content: [{ type: 'text', text: 'assignees' }] })),
}));

jest.mock('../../src/tools/tasks/labels', () => ({
  applyLabels: jest.fn(async () => ({ content: [{ type: 'text', text: 'applied' }] })),
  removeLabels: jest.fn(async () => ({ content: [{ type: 'text', text: 'removed' }] })),
  listTaskLabels: jest.fn(async () => ({ content: [{ type: 'text', text: 'labels' }] })),
}));

jest.mock('../../src/tools/tasks/reminders', () => ({
  addReminder: jest.fn(async () => ({ content: [{ type: 'text', text: 'added' }] })),
  removeReminder: jest.fn(async () => ({ content: [{ type: 'text', text: 'removed' }] })),
  listReminders: jest.fn(async () => ({ content: [{ type: 'text', text: 'reminders' }] })),
}));

jest.mock('../../src/tools/tasks/comments/index', () => ({
  handleComment: jest.fn(async () => ({ content: [{ type: 'text', text: 'commented' }] })),
  listComments: jest.fn(async () => ({ content: [{ type: 'text', text: 'comments' }] })),
}));

jest.mock('../../src/tools/tasks-relations', () => ({
  handleRelationSubcommands: jest.fn(async () => ({ content: [{ type: 'text', text: 'related' }] })),
}));

jest.mock('../../src/tools/tasks/bulk-operations', () => ({
  bulkCreateTasks: jest.fn(async () => ({ content: [{ type: 'text', text: 'created' }] })),
  bulkUpdateTasks: jest.fn(async () => ({ content: [{ type: 'text', text: 'updated' }] })),
  bulkDeleteTasks: jest.fn(async () => ({ content: [{ type: 'text', text: 'deleted' }] })),
}));

jest.mock('../../src/tools/tasks/crud/index', () => ({
  createTask: jest.fn(async () => ({ content: [{ type: 'text', text: 'created' }] })),
  getTask: jest.fn(async () => ({ content: [{ type: 'text', text: 'got' }] })),
  updateTask: jest.fn(async () => ({ content: [{ type: 'text', text: 'updated' }] })),
  deleteTask: jest.fn(async () => ({ content: [{ type: 'text', text: 'deleted' }] })),
}));

jest.mock('../../src/tools/tasks/filtering/index', () => ({
  TaskFilteringOrchestrator: {
    executeTaskFiltering: jest.fn(async () => ({
      tasks: [{ id: 1, title: 'T' }],
      metadata: { serverSideFilteringUsed: true },
    })),
  },
}));

jest.mock('../../src/storage/index', () => ({
  storageManager: {
    getStorage: jest.fn(async () => ({})),
  },
}));

import { getClientFromContext, setGlobalClientFactory } from '../../src/client';
import { registerTaskAssigneesTool } from '../../src/tools/task-assignees';
import { registerTaskLabelsTool } from '../../src/tools/task-labels';
import { registerTaskRemindersTool } from '../../src/tools/task-reminders';
import { registerTaskCommentsTool } from '../../src/tools/task-comments';
import { registerTaskRelationsTool } from '../../src/tools/task-relations';
import { registerTaskBulkTool } from '../../src/tools/task-bulk';
import { registerTaskCrudTool } from '../../src/tools/task-crud';
import { assignUsers, unassignUsers, listAssignees } from '../../src/tools/tasks/assignees/index';
import { applyLabels, removeLabels, listTaskLabels } from '../../src/tools/tasks/labels';
import { addReminder, removeReminder, listReminders } from '../../src/tools/tasks/reminders';
import { handleComment, listComments } from '../../src/tools/tasks/comments/index';
import { handleRelationSubcommands } from '../../src/tools/tasks-relations';
import {
  bulkCreateTasks,
  bulkUpdateTasks,
  bulkDeleteTasks,
} from '../../src/tools/tasks/bulk-operations';
import { createTask, getTask, updateTask, deleteTask } from '../../src/tools/tasks/crud/index';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(register: (server: McpServer, auth: AuthManager, factory?: VikunjaClientFactory) => void): {
  handler: Handler;
  auth: { isAuthenticated: jest.Mock; getSession: jest.Mock };
  factory: VikunjaClientFactory;
  schema: z.ZodRawShape;
} {
  const tool = jest.fn();
  const server = { tool } as unknown as McpServer;
  const auth = {
    isAuthenticated: jest.fn().mockReturnValue(true),
    getSession: jest.fn().mockReturnValue({
      apiUrl: 'https://vikunja.example',
      apiToken: 'tk_testtoken12345678',
      userId: 1,
    }),
  };
  const factory = {} as VikunjaClientFactory;
  register(server, auth as unknown as AuthManager, factory);
  const handler = tool.mock.calls[0][3] as Handler;
  return { handler, auth, factory, schema: tool.mock.calls[0][2] as z.ZodRawShape };
}

describe('Focused task tool registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientFromContext as jest.Mock).mockResolvedValue({});
    (setGlobalClientFactory as jest.Mock).mockResolvedValue(undefined);
  });

  describe('vikunja_task_assignees', () => {
    it('routes assign/unassign/list and requires auth', async () => {
      const { handler, auth } = captureHandler(registerTaskAssigneesTool);

      await expect(handler({ operation: 'assign', id: 1, assignees: [2] })).resolves.toBeDefined();
      expect(assignUsers).toHaveBeenCalledWith({ id: 1, assignees: [2] });

      await expect(handler({ operation: 'unassign', id: 1 })).resolves.toBeDefined();
      expect(unassignUsers).toHaveBeenCalledWith({ id: 1, assignees: [] });

      await expect(handler({ operation: 'list-assignees', id: 1 })).resolves.toBeDefined();
      expect(listAssignees).toHaveBeenCalled();

      expect(setGlobalClientFactory).toHaveBeenCalled();

      auth.isAuthenticated.mockReturnValue(false);
      await expect(handler({ operation: 'assign', id: 1, assignees: [2] })).rejects.toThrow(MCPError);
    });

    it('wraps unexpected errors', async () => {
      const { handler } = captureHandler(registerTaskAssigneesTool);
      (assignUsers as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(handler({ operation: 'assign', id: 1, assignees: [2] })).rejects.toThrow(
        /Task assignee operation error: boom/,
      );
    });
  });

  describe('vikunja_task_labels', () => {
    it('routes label operations', async () => {
      const { handler, auth } = captureHandler(registerTaskLabelsTool);
      await handler({ operation: 'apply-label', id: 1, labels: [9] });
      expect(applyLabels).toHaveBeenCalledWith({ id: 1, labels: [9] });
      await handler({ operation: 'apply-label', id: 1 });
      expect(applyLabels).toHaveBeenCalledWith({ id: 1, labels: [] });
      await handler({ operation: 'remove-label', id: 1, labels: [9] });
      expect(removeLabels).toHaveBeenCalledWith({ id: 1, labels: [9] });
      await handler({ operation: 'remove-label', id: 1 });
      expect(removeLabels).toHaveBeenCalledWith({ id: 1, labels: [] });
      await handler({ operation: 'list-labels', id: 1 });
      expect(listTaskLabels).toHaveBeenCalled();

      await expect(handler({ operation: 'nope', id: 1 })).rejects.toThrow(/Unknown operation/);
      (applyLabels as jest.Mock).mockRejectedValueOnce(new Error('label boom'));
      await expect(handler({ operation: 'apply-label', id: 1, labels: [1] })).rejects.toThrow(
        /Task label operation error/,
      );
      auth.isAuthenticated.mockReturnValue(false);
      await expect(handler({ operation: 'list-labels', id: 1 })).rejects.toThrow(MCPError);
    });
  });

  describe('vikunja_task_reminders', () => {
    it('routes reminder operations', async () => {
      const { handler, auth } = captureHandler(registerTaskRemindersTool);
      await handler({ operation: 'add-reminder', id: 1, reminderDate: '2026-01-01' });
      expect(addReminder).toHaveBeenCalledWith({ id: 1, reminderDate: '2026-01-01' });
      await handler({ operation: 'remove-reminder', id: 1, reminderId: 5 });
      expect(removeReminder).toHaveBeenCalledWith({ id: 1, reminderId: 5 });
      await handler({ operation: 'list-reminders', id: 1 });
      expect(listReminders).toHaveBeenCalled();

      await expect(handler({ operation: 'nope', id: 1 })).rejects.toThrow(/Unknown operation/);
      (addReminder as jest.Mock).mockRejectedValueOnce('string-fail');
      await expect(
        handler({ operation: 'add-reminder', id: 1, reminderDate: '2026-01-01' }),
      ).rejects.toThrow(/Task reminder operation error/);
      auth.isAuthenticated.mockReturnValue(false);
      await expect(handler({ operation: 'list-reminders', id: 1 })).rejects.toThrow(MCPError);
    });
  });

  describe('vikunja_task_comments', () => {
    it('exposes validated pagination fields and forwards them to listComments', async () => {
      const { handler, schema } = captureHandler(registerTaskCommentsTool);
      const args = { operation: 'list', id: 123, page: 2, perPage: 20, newestFirst: true };
      expect(z.object(schema).strict().parse(args)).toEqual(args);
      await handler(args);
      expect(listComments).toHaveBeenCalledWith({ id: 123, page: 2, perPage: 20, newestFirst: true });
      await handler({ operation: 'list', id: 123 });
      expect(listComments).toHaveBeenLastCalledWith({ id: 123 });
      for (const field of ['page', 'perPage']) {
        for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(z.object(schema).safeParse({ ...args, [field]: value }).success).toBe(false);
        }
      }
      expect(z.object(schema).safeParse({ ...args, newestFirst: 'true' }).success).toBe(false);
    });

    it('routes comment operation and wraps errors', async () => {
      const { handler } = captureHandler(registerTaskCommentsTool);
      await handler({ operation: 'comment', id: 1, comment: 'hi' });
      expect(handleComment).toHaveBeenCalled();
      (handleComment as jest.Mock).mockRejectedValueOnce('string-fail');
      await expect(handler({ operation: 'comment', id: 1, comment: 'hi' })).rejects.toThrow(
        /Task comment operation error/,
      );
    });
  });

  describe('vikunja_task_relations', () => {
    it('routes relation operations', async () => {
      const { handler } = captureHandler(registerTaskRelationsTool);
      await handler({
        operation: 'relate',
        id: 1,
        otherTaskId: 2,
        relationKind: 'related',
      });
      expect(handleRelationSubcommands).toHaveBeenCalledWith({
        subcommand: 'relate',
        id: 1,
        otherTaskId: 2,
        relationKind: 'related',
      });
    });
  });

  describe('vikunja_task_bulk', () => {
    it('routes bulk operations and validates required fields', async () => {
      const { handler } = captureHandler(registerTaskBulkTool);

      await expect(handler({ operation: 'bulk-create', tasks: [{ title: 'A' }] })).rejects.toThrow(
        /projectId is required/,
      );
      await handler({
        operation: 'bulk-create',
        projectId: 1,
        tasks: [{ title: 'A', description: 'd', priority: 1, labels: [1], assignees: [2] }],
      });
      expect(bulkCreateTasks).toHaveBeenCalled();

      await expect(handler({ operation: 'bulk-update', taskIds: [1] })).rejects.toThrow(
        /field is required/,
      );
      await handler({ operation: 'bulk-update', taskIds: [1], field: 'done', value: true });
      expect(bulkUpdateTasks).toHaveBeenCalled();

      await handler({ operation: 'bulk-delete', taskIds: [1, 2] });
      expect(bulkDeleteTasks).toHaveBeenCalledWith({ taskIds: [1, 2] });
    });
  });

  describe('vikunja_task_crud', () => {
    it('routes CRUD operations and list filtering', async () => {
      const { handler } = captureHandler(registerTaskCrudTool);

      await expect(handler({ operation: 'create', title: 'x' })).rejects.toThrow(/projectId is required/);
      await handler({ operation: 'create', projectId: 1, title: 'x' });
      expect(createTask).toHaveBeenCalled();

      await expect(handler({ operation: 'get' })).rejects.toThrow(/Task ID is required/);
      await handler({ operation: 'get', id: 1 });
      expect(getTask).toHaveBeenCalled();

      await expect(handler({ operation: 'update' })).rejects.toThrow(/Task ID is required/);
      await handler({ operation: 'update', id: 1, title: 'y' });
      expect(updateTask).toHaveBeenCalled();

      await expect(handler({ operation: 'delete' })).rejects.toThrow(/Task ID is required/);
      await handler({ operation: 'delete', id: 1 });
      expect(deleteTask).toHaveBeenCalled();

      const listed = await handler({ operation: 'list', filter: 'done = false' });
      expect(listed).toBeDefined();
      expect((listed as { content: Array<{ text: string }> }).content[0].text).toContain('Success');
    });

    it('wraps unexpected list errors', async () => {
      const { TaskFilteringOrchestrator } = require('../../src/tools/tasks/filtering/index');
      TaskFilteringOrchestrator.executeTaskFiltering.mockRejectedValueOnce(new Error('filter boom'));
      const { handler } = captureHandler(registerTaskCrudTool);
      await expect(handler({ operation: 'list' })).rejects.toThrow();
    });

    it('covers list metadata fallbacks and anonymous sessions', async () => {
      const { TaskFilteringOrchestrator } = require('../../src/tools/tasks/filtering/index');
      const { handler, auth } = captureHandler(registerTaskCrudTool);

      auth.getSession.mockReturnValue({ apiUrl: 'https://x', apiToken: undefined });
      TaskFilteringOrchestrator.executeTaskFiltering.mockResolvedValueOnce({
        tasks: undefined,
        metadata: { serverSideFilteringUsed: false, serverSideFilteringAttempted: true },
      });
      await expect(handler({ operation: 'list' })).resolves.toBeDefined();

      TaskFilteringOrchestrator.executeTaskFiltering.mockResolvedValueOnce({
        tasks: [],
        metadata: { serverSideFilteringUsed: false, serverSideFilteringAttempted: false },
      });
      await expect(handler({ operation: 'list' })).resolves.toBeDefined();

      TaskFilteringOrchestrator.executeTaskFiltering.mockResolvedValueOnce({
        tasks: [{ id: 1 }],
        metadata: undefined,
      });
      await expect(handler({ operation: 'list' })).resolves.toBeDefined();

      TaskFilteringOrchestrator.executeTaskFiltering.mockRejectedValueOnce(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'bad list'),
      );
      await expect(handler({ operation: 'list' })).rejects.toThrow('bad list');

      await expect(handler({ operation: 'nope' })).rejects.toThrow(/Unknown operation/);
      auth.isAuthenticated.mockReturnValue(false);
      await expect(handler({ operation: 'list' })).rejects.toThrow(/Authentication required/);
    });
  });

  describe('vikunja_task_bulk extras', () => {
    it('maps optional create fields and unknown operations', async () => {
      const { handler, auth } = captureHandler(registerTaskBulkTool);
      await handler({
        operation: 'bulk-create',
        projectId: 1,
        tasks: [
          {
            title: 'A',
            dueDate: '2024-01-01',
            repeatAfter: 7,
            repeatMode: 'day',
          },
        ],
      });
      expect(bulkCreateTasks).toHaveBeenCalled();

      await expect(handler({ operation: 'nope' })).rejects.toThrow(/Unknown operation/);
      auth.isAuthenticated.mockReturnValue(false);
      await expect(handler({ operation: 'bulk-delete', taskIds: [1] })).rejects.toThrow(
        /Authentication required/,
      );
    });
  });
});
