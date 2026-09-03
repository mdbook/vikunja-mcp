/**
 * Server-side filtering strategy
 * 
 * This strategy attempts to use Vikunja's server-side filtering capabilities
 * by passing filter parameters directly to the API. This is the most efficient
 * approach when the server supports advanced filtering.
 */

import type { Task, GetTasksParams } from 'node-vikunja';
import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult } from './types';
import { getClientFromContext } from '../../client';
import { validateId } from '../../tools/tasks/validation';
import { fetchTaskPages } from './paginateTasks';
import { logger } from '../logger';
import { MCPError, ErrorCode } from '../../types';

export class ServerSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterString, params: apiParams } = params;
    
    if (!filterString) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Server-side filtering requires a filter string'
      );
    }

    const client = await getClientFromContext();
    const serverParams = { ...apiParams, filter: filterString };
    
    logger.info('Attempting server-side filtering', {
      filter: filterString,
      endpoint: args.projectId && !args.allProjects ? 'getProjectTasks' : 'getAllTasks'
    });
    
    try {
      // Validate project ID up front when scoping to a project.
      if (args.projectId !== undefined && !args.allProjects) {
        validateId(args.projectId, 'projectId');
      }

      // One page fetcher (carries the server-side filter) used for both the
      // single-page and auto-paginate contracts.
      const fetchPage = (params: GetTasksParams): Promise<Task[] | undefined> =>
        args.projectId !== undefined && !args.allProjects
          ? client.tasks.getProjectTasks(args.projectId, params)
          : client.tasks.getAllTasks(params);

      const pageResult = await fetchTaskPages(fetchPage, serverParams, Boolean(args.allTasks));
      const tasks = pageResult.tasks;

      logger.info('Server-side filtering completed successfully', {
        taskCount: tasks?.length || 0,
        filter: filterString,
        paginationMode: pageResult.paginationMode,
        pagesFetched: pageResult.pagesFetched,
      });

      return {
        tasks: tasks || [],
        metadata: {
          serverSideFilteringUsed: true,
          serverSideFilteringAttempted: true,
          clientSideFiltering: false,
          filteringNote: 'Server-side filtering used (modern Vikunja)',
          paginationMode: pageResult.paginationMode,
          pagesFetched: pageResult.pagesFetched,
          ...(pageResult.possiblyTruncated ? { possiblyTruncated: true } : {}),
        }
      };

    } catch (error) {
      logger.error('Server-side filtering failed', {
        error: error instanceof Error ? error.message : String(error),
        filter: filterString
      });
      
      // Re-throw the error to be handled by the calling code
      throw error;
    }
  }
}