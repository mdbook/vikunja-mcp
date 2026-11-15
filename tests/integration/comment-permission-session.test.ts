import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VikunjaClient } from 'node-vikunja';
import { AuthManager } from '../../src/auth/AuthManager';
import { VikunjaClientFactory, clearGlobalClientFactory } from '../../src/client';
import { factoryInitializationPromise } from '../../src/index';
import { registerTaskCommentsTool } from '../../src/tools/task-comments';
import { registerTaskCrudTool } from '../../src/tools/task-crud';
import { ErrorCode } from '../../src/types';
import { circuitBreakerRegistry } from '../../src/utils/retry';

// Exercise the installed SDK, not __mocks__/node-vikunja.ts. Only HTTP is mocked;
// comment validation, operations, client caching, and read/list handlers are real.
jest.unmock('node-vikunja');

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

describe('Comment permission failures on a shared production client (ticket 2687)', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await clearGlobalClientFactory();
    circuitBreakerRegistry.clear();
  });

  it.each([401, 403])(
    'sends one comment update on HTTP %i and still permits task get/list with unchanged credentials',
    async (status) => {
      // TaskReadService imports the server barrel. Let its startup finish before
      // registering our session so startup cannot replace this test's factory.
      await factoryInitializationPromise;
      const auth = new AuthManager();
      auth.connect('https://vikunja.example/api/v1', 'tk_test_comment_permissions');
      const session = { ...auth.getSession() };
      const factory = new VikunjaClientFactory(auth, VikunjaClient);
      const client = factory.getClient();

      const handlers = new Map<string, ToolHandler>();
      const server = {
        tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
          handlers.set(name, handler);
        },
      } as unknown as McpServer;
      registerTaskCommentsTool(server, auth, factory);
      registerTaskCrudTool(server, auth, factory);
      const comments = handlers.get('vikunja_task_comments')!;
      const tasks = handlers.get('vikunja_task_crud')!;

      const task = {
        id: 42,
        title: 'Task remains readable after a denied comment edit',
        description: '',
        project_id: 1,
        done: false,
        labels: [],
        assignees: [],
      };
      const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          path: url.pathname,
          authorization: new Headers(init?.headers).get('Authorization'),
        });

        if (method === 'POST' && url.pathname === '/api/v1/tasks/42/comments/7') {
          return Response.json({ code: status, message: 'Comment edit denied' }, { status });
        }
        if (method === 'GET' && url.pathname === '/api/v1/tasks/42') {
          return Response.json(task);
        }
        if (method === 'GET' && url.pathname === '/api/v1/tasks') {
          return Response.json([task]);
        }
        throw new Error(`Unexpected HTTP request: ${method} ${url.pathname}`);
      });

      // This traverses comments/index.ts -> CommentOperationsService.updateComment
      // -> the actual SDK's updateTaskComment -> fetch returning a real HTTP error.
      await expect(
        comments({ operation: 'update', id: 42, commentId: 7, comment: 'Edited comment' }),
      ).rejects.toMatchObject({
        code: ErrorCode.API_ERROR,
        message: expect.stringContaining('Failed to update comment:'),
      });
      expect(factory.getClient()).toBe(client);

      const getResult = await tasks({ operation: 'get', id: 42 });
      expect(getResult.content[0]!.text).toContain('Retrieved task');
      expect(getResult.content[0]!.text).toContain(task.title);
      expect(factory.getClient()).toBe(client);

      const listResult = await tasks({ operation: 'list', page: 1, perPage: 10 });
      expect(listResult.content[0]!.text).toContain('Found 1 tasks');
      expect(listResult.content[0]!.text).toContain(task.title);
      expect(factory.getClient()).toBe(client);
      expect(auth.getSession()).toEqual(session);

      // Exact wire-level counts also catch retries hidden inside the SDK/app.
      expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'POST', path: '/api/v1/tasks/42/comments/7' },
        { method: 'GET', path: '/api/v1/tasks/42' },
        { method: 'GET', path: '/api/v1/tasks' },
      ]);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
        id: 7,
        task_id: 42,
        comment: 'Edited comment',
      });
      expect(requests[0]!.authorization).toBeTruthy();
      expect(new Set(requests.map(({ authorization }) => authorization)).size).toBe(1);
    },
  );
});
