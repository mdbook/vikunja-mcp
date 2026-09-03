/**
 * Client-side filtering strategy
 * 
 * This strategy loads all tasks from the API and then applies filtering
 * logic on the client side. This is the traditional approach that works
 * with all versions of Vikunja but may be less efficient for large datasets.
 */

import type { Task, GetTasksParams } from 'node-vikunja';
import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult } from './types';
import { getClientFromContext } from '../../client';
import { validateId } from '../../tools/tasks/validation';
import { applyFilter } from '../../tools/tasks/filtering';
import { fetchTaskPages } from './paginateTasks';
import { logger } from '../logger';

export class ClientSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterExpression, filterString, params: apiParams } = params;
    
    const client = await getClientFromContext();
    
    logger.info('Using client-side filtering', {
      filter: filterString,
      endpoint: args.projectId && !args.allProjects ? 'getProjectTasks' : 'getAllTasks'
    });
    
    // Validate project ID up front when scoping to a project.
    if (args.projectId !== undefined && !args.allProjects) {
      validateId(args.projectId, 'projectId');
    }

    // One page fetcher used for both single-page and auto-paginate contracts.
    const fetchPage = (params: GetTasksParams): Promise<Task[] | undefined> =>
      args.projectId !== undefined && !args.allProjects
        ? client.tasks.getProjectTasks(args.projectId, params)
        : client.tasks.getAllTasks(params);

    // Load tasks without server-side filtering. When client-side filtering a
    // full page's worth of tasks may be scattered across pages, so auto-paginate
    // (opt-in via allTasks) is what makes a client-side sweep complete.
    const pageResult = await fetchTaskPages(fetchPage, apiParams, Boolean(args.allTasks));
    const tasks = pageResult.tasks;

    logger.info('Tasks loaded for client-side filtering', {
      totalTasksLoaded: tasks?.length || 0,
      filter: filterString,
      paginationMode: pageResult.paginationMode,
      pagesFetched: pageResult.pagesFetched,
    });

    // Apply client-side filtering if we have a filter expression
    const safeTasks = tasks || [];
    let filteredTasks = safeTasks;

    if (filterExpression) {
      const originalCount = safeTasks.length;
      filteredTasks = applyFilter(safeTasks, filterExpression);
      logger.debug('Applied client-side filter', {
        originalCount,
        filteredCount: filteredTasks?.length || 0,
        filter: filterString,
      });
    }

    return {
      tasks: filteredTasks || [],
      metadata: {
        serverSideFilteringUsed: false,
        serverSideFilteringAttempted: false,
        clientSideFiltering: Boolean(filterExpression),
        filteringNote: filterExpression
          ? 'Client-side filtering applied'
          : 'No filter applied; tasks returned as loaded',
        paginationMode: pageResult.paginationMode,
        pagesFetched: pageResult.pagesFetched,
        ...(pageResult.possiblyTruncated ? { possiblyTruncated: true } : {}),
      }
    };
  }
}