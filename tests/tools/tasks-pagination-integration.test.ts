/**
 * Integration coverage for task-list pagination truncation detection.
 *
 * Exercises the REAL wiring end-to-end through the vikunja_task_crud tool:
 *   handler -> TaskFilteringOrchestrator -> FilterExecutor.prepareQueryParameters
 *   -> ClientSideFilteringStrategy -> fetchTaskPages (+ lookahead)
 * Only the Vikunja client, storage, and auth are mocked. This is the test that
 * would have caught the reviewer's live repro: a default sweep
 * (`{ operation: 'list', allProjects: true }`) whose >50 result the server caps
 * to 50 must be flagged possiblyTruncated even though prepareQueryParameters
 * inflated per_page to 1000.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../../src/auth/AuthManager';
import type { Task, GetTasksParams } from 'node-vikunja';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/storage/index', () => ({
  storageManager: {
    getStorage: jest.fn(async () => ({
      get: jest.fn(),
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findByName: jest.fn(),
    })),
  },
}));

import { getClientFromContext } from '../../src/client';
import { registerTaskCrudTool } from '../../src/tools/task-crud';

const mockedGetClient = getClientFromContext as jest.MockedFunction<typeof getClientFromContext>;

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function makeTasks(count: number, offset = 0): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: offset + i + 1,
    title: `Task ${offset + i + 1}`,
    done: false,
  })) as unknown as Task[];
}

function captureHandler(): Handler {
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
  registerTaskCrudTool(server, auth as unknown as AuthManager);
  return tool.mock.calls[0][3] as Handler;
}

describe('task list pagination truncation (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flags truncation (metadata + summary) on a default sweep the server caps at 50', async () => {
    const getAllTasks = jest.fn<(p?: GetTasksParams) => Promise<Task[]>>()
      // page 1: server caps the inflated per_page:1000 down to 50
      .mockResolvedValueOnce(makeTasks(50, 0))
      // page+1 lookahead (per_page:1): a real next item exists
      .mockResolvedValueOnce(makeTasks(1, 50));
    mockedGetClient.mockResolvedValue({
      tasks: { getAllTasks, getProjectTasks: jest.fn() },
    } as never);

    const handler = captureHandler();
    const res = await handler({ operation: 'list', allProjects: true });
    const md = res.content[0].text;

    // Human-readable summary carries the truncation warning...
    expect(md).toContain('Found 50 tasks');
    expect(md).toContain('page full');
    expect(md).toContain('allTasks:true');
    // ...and so does the machine-readable metadata.
    expect(md).toContain('possiblyTruncated');

    // Proof of the real wiring: prepareQueryParameters inflated per_page to 1000,
    // and the truncation signal came from a per_page:1 lookahead — NOT from the
    // (wrong) requested-size comparison.
    expect(getAllTasks).toHaveBeenCalledTimes(2);
    expect(getAllTasks.mock.calls[0][0]).toMatchObject({ per_page: 1000 });
    expect(getAllTasks.mock.calls[1][0]).toMatchObject({ per_page: 1 });
  });

  it('does NOT flag a small default result (no lookahead, no warning)', async () => {
    const getAllTasks = jest.fn<(p?: GetTasksParams) => Promise<Task[]>>()
      .mockResolvedValue(makeTasks(30, 0));
    mockedGetClient.mockResolvedValue({
      tasks: { getAllTasks, getProjectTasks: jest.fn() },
    } as never);

    const handler = captureHandler();
    const res = await handler({ operation: 'list', allProjects: true });
    const md = res.content[0].text;

    expect(md).toContain('Found 30 tasks');
    expect(md).not.toContain('page full');
    // 30 < 50 → below the cap threshold → single request, no lookahead
    expect(getAllTasks).toHaveBeenCalledTimes(1);
  });
});
