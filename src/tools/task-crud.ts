/**
 * Individual Task CRUD Tool
 * Handles basic task operations: create, get, update, delete, list
 * Replaces monolithic tasks tool with focused individual tool
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import type { Task } from '../types';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { storageManager } from '../storage/index';
import type { TaskListingArgs } from './tasks/types/filters';
import type { CreateTaskArgs, UpdateTaskArgs, DeleteTaskArgs, GetTaskArgs } from './tasks/crud/index';
import { createTask, getTask, updateTask, deleteTask } from './tasks/crud/index';
import { TaskFilteringOrchestrator } from './tasks/filtering/index';
import { createAuthRequiredError, handleFetchError } from '../utils/error-handler';
import { createSuccessResponse, formatMcpResponse } from '../utils/simple-response';

/**
 * Get session-scoped storage instance
 */
async function getSessionStorage(authManager: AuthManager): ReturnType<typeof storageManager.getStorage> {
  const session = authManager.getSession();
  const sessionId = session.apiToken ? `${session.apiUrl}:${session.apiToken.substring(0, 8)}` : 'anonymous';
  return storageManager.getStorage(sessionId, session.userId, session.apiUrl);
}

/**
 * List tasks with optional filtering
 */
async function listTasks(
  args: TaskListingArgs,
  storage: Awaited<ReturnType<typeof storageManager.getStorage>>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    // Execute the complete filtering workflow using the orchestrator
    const filteringResult = await TaskFilteringOrchestrator.executeTaskFiltering(args, storage);

    // Determine filtering method message
    let filteringMessage = '';
    if (args.filter) {
      if (filteringResult.metadata?.serverSideFilteringUsed) {
        filteringMessage = ' (filtered server-side)';
      } else if (filteringResult.metadata?.serverSideFilteringAttempted) {
        filteringMessage = ' (filtered client-side - server-side fallback)';
      } else {
        filteringMessage = ' (filtered client-side)';
      }
    }

    const tasks = filteringResult.tasks || [];
    const metadata = filteringResult.metadata || {};

    // Type the filtering metadata properly
    const filteringMetadata = metadata;

    // Surface possible truncation in the summary line so a capped sweep is
    // never silent — the caller should re-run with allTasks:true to be sure.
    const truncationNote = metadata.possiblyTruncated
      ? ' (page full — more may exist; pass allTasks:true to fetch all)'
      : '';

    const response = createSuccessResponse(
      'list-tasks',
      `Found ${tasks.length} tasks${filteringMessage}${truncationNote}`,
      { tasks: tasks as Task[] }, // Convert from node-vikunja Task to our Task interface
      {
        count: tasks.length,
        filteringMethod: filteringMetadata.serverSideFilteringUsed ? 'server-side' :
                           filteringMetadata.serverSideFilteringAttempted ? 'client-side-fallback' : 'client-side',
        ...metadata,
      }
    );

    logger.debug('Task CRUD tool response', { operation: 'list', itemCount: tasks.length });

    return {
      content: formatMcpResponse(response)
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }

    // Log the full error for debugging filter issues
    logger.error('Task list error:', {
      error: error instanceof Error ? error.message : String(error),
      filter: args.filter,
      filterId: args.filterId,
    });

    throw handleFetchError(error, 'list tasks');
  }
}

/**
 * Register individual task CRUD tool
 */
export function registerTaskCrudTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  server.tool(
    'vikunja_task_crud',
    'Manage individual tasks: create, get, update, delete, list. '
      + 'Pagination for list: by default one page is returned (honoring page/perPage); '
      + 'Vikunja caps a page at its server-side MaxItemsPerPage (~50), so a large sweep can be '
      + 'truncated (response metadata sets possiblyTruncated when a full page comes back). '
      + 'Pass allTasks:true to auto-paginate and return EVERY matching task (metadata reports '
      + 'paginationMode:"auto" and pagesFetched).',
    {
      operation: z.enum(['create', 'get', 'update', 'delete', 'list']),
      // Task creation/update fields
      title: z.string().optional(),
      description: z.string().optional(),
      projectId: z.number().optional(),
      dueDate: z.string().optional(),
      priority: z.number().min(0).max(5).optional(),
      /** Completion percentage 0–100 (Vikunja percent_done) */
      percentDone: z.number().min(0).max(100).optional(),
      labels: z.array(z.number()).optional(),
      assignees: z.array(z.number()).optional(),
      // Recurring task fields
      repeatAfter: z.number().min(0).optional(),
      repeatMode: z.enum(['day', 'week', 'month', 'year']).optional(),
      // Query fields
      id: z.number().optional(),
      filter: z.string().optional(),
      filterId: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      sort: z.string().optional(),
      search: z.string().optional(),
      // List specific filters
      allProjects: z.boolean().optional(),
      done: z.boolean().optional(),
      // Auto-paginate: fetch every matching page instead of a single capped page
      allTasks: z.boolean().optional(),
      // Session ID for AORP response tracking
      sessionId: z.string().optional(),
    },
    async (args) => {
      try {
        logger.debug('Executing task CRUD tool', { operation: args.operation, args });

        // Check authentication
        if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task CRUD operations');
        }

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getClientFromContext();

        switch (args.operation) {
          case 'list': {
            const storage = await getSessionStorage(authManager);
            return await listTasks(args as Parameters<typeof listTasks>[0], storage);
          }

          case 'create': {
            // Filter args to ensure required properties are present
            if (args.projectId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'projectId is required to create a task');
            }
            return await createTask(args as CreateTaskArgs);
          }

          case 'get': {
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to get a task');
            }
            return await getTask(args as GetTaskArgs);
          }

          case 'update': {
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to update a task');
            }
            return await updateTask(args as UpdateTaskArgs);
          }

          case 'delete': {
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to delete a task');
            }
            return await deleteTask(args as DeleteTaskArgs);
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown operation: ${String(args.operation)}`,
            );
        }
      } catch (error) {
        if (error instanceof MCPError) {
          throw error;
        }
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Task CRUD operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}