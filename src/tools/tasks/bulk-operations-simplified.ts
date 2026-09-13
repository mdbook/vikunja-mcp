/**
 * Simplified bulk operations for tasks (~250 lines)
 * Uses BulkOperationValidator + shared batch processor helpers.
 */

import { MCPError, ErrorCode, createStandardResponse, getClientFromContext, logger, isAuthenticationError, isRetryableAuthError, transformApiError, handleFetchError } from '../../index';
import type { Assignee } from '../../types';
import { withRetry, isRetryableError, RETRY_CONFIG, type RetryOptions } from '../../utils/retry';
import { addLabelsToTaskAdditive } from './labels';
import { addAssigneesToTaskAdditive } from './assignees';
import { BatchProcessor } from '../../utils/performance/batch-processor';
import type { Task } from 'node-vikunja';
import { convertRepeatConfiguration, applyFieldUpdate } from './validation';
import { formatAorpAsMarkdown } from '../../utils/response-factory';
import { AUTH_ERROR_MESSAGES, REPEAT_MODE_MAP } from './constants';
import { bulkOperationValidator } from './bulk/BulkOperationValidator';
import type { BulkUpdateArgs, BulkDeleteArgs, BulkCreateArgs, BulkCreateTaskData } from './bulk/BulkOperationValidator';

// ==================== BATCH PROCESSORS ====================

/**
 * SQLite (Vikunja's default DB) serializes writers. Parallel bulk writes hit
 * "database is locked" → HTTP 500. Default to one write at a time; override with
 * VIKUNJA_BULK_WRITE_CONCURRENCY when the backend can take more (e.g. Postgres).
 */
export function resolveBulkWriteConcurrency(fallback = 1): number {
  const raw = process.env.VIKUNJA_BULK_WRITE_CONCURRENCY;
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, 8);
}

const writeConcurrency = resolveBulkWriteConcurrency(1);

const processors = {
  update: new BatchProcessor({ maxConcurrency: writeConcurrency, batchSize: 10, enableMetrics: true, batchDelay: 0 }),
  delete: new BatchProcessor({ maxConcurrency: writeConcurrency, batchSize: 5, enableMetrics: true, batchDelay: 100 }),
  create: new BatchProcessor({ maxConcurrency: writeConcurrency, batchSize: 15, enableMetrics: true, batchDelay: 0 }),
};

/** Built at call time so partial test mocks of RETRY_CONFIG cannot crash module load. */
function bulkWriteRetryOptions(): RetryOptions {
  return {
    ...(RETRY_CONFIG.BULK_WRITES ?? {
      maxRetries: 3,
      initialDelay: 200,
      maxDelay: 5000,
      backoffFactor: 2,
      enableCircuitBreaker: false,
    }),
    shouldRetry: isRetryableError,
  };
}

// ==================== VALIDATION WRAPPERS ====================

// Re-use validation logic from BulkOperationValidator to eliminate duplication
const validateBulkUpdate = (args: BulkUpdateArgs): void => {
  bulkOperationValidator.validateBulkUpdate(args);
  bulkOperationValidator.preprocessFieldValue(args);
  bulkOperationValidator.validateFieldConstraints(args);
};

const validateBulkCreate = (args: BulkCreateArgs): void => bulkOperationValidator.validateBulkCreate(args);
const validateBulkDelete = (args: BulkDeleteArgs): void => bulkOperationValidator.validateBulkDelete(args);

// Re-export types for backward compatibility
export type { BulkUpdateArgs, BulkDeleteArgs, BulkCreateArgs, BulkCreateTaskData };

// ==================== RESPONSE HELPERS ====================

interface SuccessResponse {
  content: Array<{ type: 'text'; text: string }>;
}

const successResponse = (op: string, msg: string, tasks: Task[], meta: Record<string, unknown>): SuccessResponse => ({
  content: [{ type: 'text' as const, text: formatAorpAsMarkdown(createStandardResponse(op, msg, { tasks }, { timestamp: new Date().toISOString(), ...meta })) }]
});

/**
 * Resolve bulk-update field value for Vikunja's updateTask payload.
 * Native bulk API used a numeric repeat_mode map; keep that conversion when merging.
 */
export function resolveBulkUpdateValue(field: string | undefined, value: unknown): unknown {
  if (field === 'repeat_mode' && typeof value === 'string' && value in REPEAT_MODE_MAP) {
    return REPEAT_MODE_MAP[value];
  }
  return value;
}

// ==================== BULK UPDATE ====================

/**
 * Bulk-update via per-task GET + merge + POST.
 *
 * Intentionally does **not** call Vikunja's native `bulkUpdateTasks` API.
 * That endpoint only sends `{ task_ids, field, value }`, and Vikunja's task
 * update semantics are a full-model replace — omitted fields (description,
 * priority, etc.) get cleared. Using the merge path matches single-task
 * `update` and avoids silent data loss (see GitHub issue #46).
 */
export async function bulkUpdateTasks(args: BulkUpdateArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkUpdate(args);
    // Validated above by validateBulkUpdate
    const taskIds = args.taskIds as number[];
    const client = await getClientFromContext();
    const fieldValue = resolveBulkUpdateValue(args.field, args.value);

    const updateResult = await processors.update.processBatches(taskIds, async (taskId) => {
      const current = await client.tasks.getTask(taskId);
      // Spread current task so fields not being changed survive Vikunja's full replace
      const update = applyFieldUpdate({ ...current }, args.field, fieldValue);

      const updated = await withRetry(
        () => client.tasks.updateTask(taskId, update),
        bulkWriteRetryOptions(),
      );

      if (args.field === 'assignees' && Array.isArray(args.value)) {
        const desired = args.value as number[];
        const currentAssignees = (await client.tasks.getTask(taskId)).assignees
          ?.map((a: Assignee) => a.id)
          .filter((id): id is number => typeof id === 'number') || [];
        const toAdd = desired.filter((id) => !currentAssignees.includes(id));
        const toRemove = currentAssignees.filter((id) => !desired.includes(id));
        if (toAdd.length > 0) {
          try {
            await addAssigneesToTaskAdditive(client, taskId, toAdd, {
              currentAssigneeIds: currentAssignees,
            });
          } catch (assigneeError) {
            if (isAuthenticationError(assigneeError)) throw new MCPError(ErrorCode.API_ERROR, 'Assignee operations may have authentication issues');
            throw assigneeError;
          }
        }
        for (const userId of toRemove) {
          try { await withRetry(() => client.tasks.removeUserFromTask(taskId, userId), { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isRetryableAuthError }); }
          catch (e) { if (isAuthenticationError(e)) throw new MCPError(ErrorCode.API_ERROR, `${AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE_PARTIAL} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`); throw e; }
        }
      }
      if (args.field === 'labels' && Array.isArray(args.value)) {
        // Avoid bulk updateTaskLabels ({label_ids}): Vikunja expects {labels} and
        // otherwise clears every label. Same additive semantics as single-task update.
        await addLabelsToTaskAdditive(client, taskId, args.value as number[]);
      }
      return updated;
    });

    if (updateResult.failed.length > 0 && updateResult.successful.length === 0) {
      const firstError = updateResult.failed[0]?.error;
      // Preserve MCPError instances with auth messages
      if (firstError instanceof MCPError && firstError.message.includes('authentication')) throw firstError;
      throw new MCPError(ErrorCode.API_ERROR, `Bulk update failed. Could not update any tasks. Failed IDs: ${updateResult.failed.map(f => f.originalItem).join(', ')}`);
    }
    if (updateResult.failed.length > 0) {
      const failedIds = updateResult.failed.map(f => f.originalItem);
      return successResponse(
        'update-task',
        `Bulk update partially completed. Successfully updated ${updateResult.successful.length} tasks, ${updateResult.failed.length} failed.`,
        updateResult.successful,
        {
          count: updateResult.successful.length,
          failedCount: updateResult.failed.length,
          failedIds,
          affectedFields: [args.field],
          success: false,
          performanceMetrics: {
            totalDuration: updateResult.metrics.totalDuration,
            operationsPerSecond: updateResult.metrics.operationsPerSecond,
            apiCallsUsed: updateResult.metrics.successfulOperations + updateResult.metrics.failedOperations,
          },
        },
      );
    }
    return successResponse('update-task', `Successfully updated ${updateResult.successful.length} tasks`, updateResult.successful, {
      count: updateResult.successful.length, affectedFields: [args.field], performanceMetrics: {
        totalDuration: updateResult.metrics.totalDuration, operationsPerSecond: updateResult.metrics.operationsPerSecond,
        apiCallsUsed: updateResult.metrics.successfulOperations + updateResult.metrics.failedOperations,
      },
    });
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) throw handleFetchError(error, 'bulk update tasks');
    throw transformApiError(error, 'Failed to bulk update tasks');
  }
}

// ==================== BULK DELETE ====================

export async function bulkDeleteTasks(args: BulkDeleteArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkDelete(args);
    // Validated above by validateBulkDelete
    const taskIds = args.taskIds as number[];
    const client = await getClientFromContext();

    const fetchResult = await processors.delete.processBatches(taskIds, async (id) => await client.tasks.getTask(id));
    const deletionResult = await processors.delete.processBatches(taskIds, async (id) => {
      await withRetry(() => client.tasks.deleteTask(id), bulkWriteRetryOptions());
      return { taskId: id, deleted: true };
    });

    if (deletionResult.failed.length > 0) {
      const failedIds = deletionResult.failed.map(f => f.originalItem);
      if (deletionResult.successful.length > 0) {
        return successResponse('delete-task', `Bulk delete partially completed. Successfully deleted ${deletionResult.successful.length} tasks. Failed to delete task IDs: ${failedIds.join(', ')}`, [], {
          count: deletionResult.successful.length, failedCount: deletionResult.failed.length, failedIds, previousState: fetchResult.successful, success: false,
        });
      }
      throw new MCPError(ErrorCode.API_ERROR, `Bulk delete failed. Could not delete any tasks. Failed IDs: ${failedIds.join(', ')}`);
    }

    return successResponse('delete-task', `Successfully deleted ${taskIds.length} tasks`, [], { count: taskIds.length, deletedTaskIds: taskIds, previousState: fetchResult.successful });
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) throw handleFetchError(error, 'bulk delete tasks');
    throw transformApiError(error, 'Failed to bulk delete tasks');
  }
}

// ==================== BULK CREATE ====================

export async function bulkCreateTasks(args: BulkCreateArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkCreate(args);
  } catch (error) {
    // Preserve validation errors
    if (error instanceof MCPError) throw error;
    throw error;
  }

  try {
    const client = await getClientFromContext();
    // Validated above by validateBulkCreate
    const projectId = args.projectId as number;
    const tasks = args.tasks as BulkCreateTaskData[];

    const creationResult = await processors.create.processBatches(
      tasks.map((_, i) => i),
      async (index) => {
        const t = tasks[index] as BulkCreateTaskData;

        const newTask: Task = { title: t.title, project_id: projectId };
        if (t.description !== undefined) newTask.description = t.description;
        if (t.dueDate !== undefined) newTask.due_date = t.dueDate;
        if (t.priority !== undefined) newTask.priority = t.priority;
        if (t.percentDone !== undefined) newTask.percent_done = t.percentDone;
        if (t.repeatAfter !== undefined || t.repeatMode !== undefined) {
          const rc = convertRepeatConfiguration(t.repeatAfter, t.repeatMode);
          if (rc.repeat_after !== undefined) newTask.repeat_after = rc.repeat_after;
          if (rc.repeat_mode !== undefined) (newTask as Record<string, unknown>).repeat_mode = rc.repeat_mode;
        }

        const created = await withRetry(
          () => client.tasks.createTask(projectId, newTask),
          bulkWriteRetryOptions(),
        );
        if (!created.id) return created;

        // Narrow type - id is guaranteed to exist after early return
        const createdId = created.id;

        try {
          const labels = t.labels;
          // Task was just created — skip the read. Avoid broken bulk label_ids payload.
          if (labels && labels.length > 0) {
            await addLabelsToTaskAdditive(client, createdId, labels, { currentLabelIds: [] });
          }
          const assignees = t.assignees;
          if (assignees && assignees.length > 0) {
            try {
              await addAssigneesToTaskAdditive(client, createdId, assignees, {
                currentAssigneeIds: [],
              });
            } catch (assigneeError) {
              if (isAuthenticationError(assigneeError)) {
                throw new MCPError(ErrorCode.API_ERROR, 'Assignee operations may have authentication issues');
              }
              // Wrap assignee errors to distinguish from createTask errors
              if (assigneeError instanceof Error) {
                const wrappedError = new MCPError(ErrorCode.API_ERROR, assigneeError.message);
                (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
                throw wrappedError;
              }
              throw assigneeError;
            }
          }
          return await client.tasks.getTask(createdId);
        } catch (updateError) {
          // Clean up the created task since labels/assignees failed
          try { await client.tasks.deleteTask(createdId); } catch (deleteError) { logger.error('Cleanup failed', deleteError); }
          // Wrap label errors to distinguish from createTask errors
          if (updateError instanceof Error && !(updateError instanceof MCPError)) {
            const wrappedError = new MCPError(ErrorCode.API_ERROR, updateError.message);
            (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
            throw wrappedError;
          }
          throw updateError;
        }
      }
    );

    const failedTasks = creationResult.failed.map(f => ({ index: f.originalItem as number, error: f.error instanceof Error ? f.error.message : String(f.error) }));
    if (failedTasks.length > 0 && creationResult.successful.length === 0) {
      const firstError = creationResult.failed[0]?.error;
      // Preserve MCPError instances with auth messages or label/assignee marker
      if (firstError instanceof MCPError && (firstError.message.includes('authentication') || (firstError as unknown as Record<string, unknown>).isLabelAssigneeError === true)) throw firstError;
      // Transform all other errors (including API errors) into generic bulk create error
      throw new MCPError(ErrorCode.API_ERROR, `Bulk create failed. Could not create any tasks`);
    }

    return successResponse('create-tasks', failedTasks.length > 0 ? `Bulk create partially completed. Successfully created ${creationResult.successful.length} tasks, ${failedTasks.length} failed.` : `Successfully created ${creationResult.successful.length} tasks`, creationResult.successful, {
      count: creationResult.successful.length, success: failedTasks.length === 0, ...(failedTasks.length > 0 && { failedCount: failedTasks.length, failures: failedTasks }),
    });
  } catch (error) {
    // Preserve MCPError instances from validation
    if (error instanceof MCPError) throw error;
    // Preserve fetch/connection errors
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) {
      throw handleFetchError(error, 'bulk create tasks');
    }
    // Transform all other errors into generic bulk create error
    throw new MCPError(ErrorCode.API_ERROR, 'Bulk create failed. Could not create any tasks');
  }
}
