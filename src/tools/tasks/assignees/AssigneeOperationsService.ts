/**
 * Assignee operations service
 * Handles core business logic for task assignee management
 */

import type { MinimalTask, TaskWithAssignees, Assignee } from '../../../types';
import { MCPError, ErrorCode } from '../../../types';
import { getClientFromContext } from '../../../client';
import type { VikunjaClient } from 'node-vikunja';
import { isAuthenticationError, isRetryableAuthError } from '../../../utils/auth-error-handler';
import { withRetry, RETRY_CONFIG, getHttpStatus } from '../../../utils/retry';
import { AUTH_ERROR_MESSAGES } from '../constants';

/**
 * Describe what Vikunja actually returned: `HTTP <status>: <message>`, plus the server's
 * body message when it differs from the error message. Status via `getHttpStatus`
 * (`.statusCode` first — the property real node-vikunja errors carry it on). On
 * node-vikunja errors `.response` is the JSON body (`{message, code}`), not an HTTP response.
 */
export function describeVikunjaError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = getHttpStatus(error);
  const body =
    error !== null && typeof error === 'object'
      ? (error as { response?: { message?: unknown } }).response?.message
      : undefined;
  const serverNote =
    typeof body === 'string' && body !== '' && body !== message ? ` (server: ${body})` : '';
  return status ? `HTTP ${status}: ${message}${serverNote}` : `${message}${serverNote}`;
}

/**
 * Build the error message for an auth failure on an assignee write, carrying the real
 * Vikunja status/message. `retried` is true only for a retryable (401) error whose
 * retries were exhausted — a 403 fails fast and must not claim a retry.
 */
function assigneeAuthMessage(prefix: string, error: unknown, retried: boolean): string {
  const retryNote = retried ? ` (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)` : '';
  return `${prefix} Vikunja returned ${describeVikunjaError(error)}${retryNote}`;
}

/**
 * Adds assignees to a task WITHOUT replacing the ones it already has.
 *
 * `node-vikunja`'s `bulkAssignUsersToTask` posts `{user_ids: [...]}` to
 * `POST /tasks/{id}/assignees/bulk`, but Vikunja expects
 * `{assignees: [{id: N}]}`. The unknown field is ignored, the server returns
 * HTTP 201 with nobody assigned, and callers that trust 2xx report success
 * (upstream issue #15 / node-vikunja#3).
 *
 * Even with a correct bulk payload, that endpoint replaces the whole set.
 * The individual endpoint (`PUT /tasks/{id}/assignees` with `{user_id}`)
 * actually applies and is additive — same pattern as labels.
 *
 * @param currentAssigneeIds IDs already on the task. Read from the server if omitted.
 *        Callers that have just CREATED the task pass `[]` and skip the read.
 */
export async function addAssigneesToTaskAdditive(
  client: VikunjaClient,
  taskId: number,
  assigneeIds: number[],
  options: { currentAssigneeIds?: number[] } = {},
): Promise<{ added: number[]; kept: number[] }> {
  let kept = options.currentAssigneeIds;
  if (kept === undefined) {
    const currentTask = await client.tasks.getTask(taskId);
    kept = (currentTask.assignees ?? [])
      .map((assignee) => assignee.id)
      .filter((id): id is number => typeof id === 'number');
  }

  const requested = [...new Set(assigneeIds)];
  const toAdd = requested.filter((id) => !kept.includes(id));

  for (const userId of toAdd) {
    await withRetry(
      () => Promise.resolve(client.tasks.assignUserToTask(taskId, userId)),
      {
        ...RETRY_CONFIG.AUTH_ERRORS,
        shouldRetry: (error: unknown) => isRetryableAuthError(error),
      },
    );
  }

  return { added: toAdd, kept };
}

/**
 * Returns requested assignee IDs that are missing from a task payload.
 */
export function findMissingAssigneeIds(
  assignees: Array<{ id?: number }> | undefined,
  requestedIds: number[],
): number[] {
  const persistedIds = new Set(
    (assignees || [])
      .map((a) => a.id)
      .filter((id): id is number => typeof id === 'number'),
  );
  return requestedIds.filter((id) => !persistedIds.has(id));
}

/**
 * Service for managing task assignee operations
 */
export const AssigneeOperationsService = {
  /**
   * Assign multiple users to a task (additive; does not clear existing assignees).
   */
  async assignUsersToTask(taskId: number, assigneeIds: number[]): Promise<void> {
    const client = await getClientFromContext();

    try {
      await addAssigneesToTaskAdditive(client, taskId, assigneeIds);
    } catch (assigneeError) {
      if (isRetryableAuthError(assigneeError)) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          assigneeAuthMessage(AUTH_ERROR_MESSAGES.ASSIGNEE_ASSIGN, assigneeError, true),
        );
      }
      if (isAuthenticationError(assigneeError)) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          assigneeAuthMessage(AUTH_ERROR_MESSAGES.ASSIGNEE_ASSIGN, assigneeError, false),
        );
      }
      throw assigneeError;
    }
  },

  /**
   * Remove multiple users from a task
   */
  async removeUsersFromTask(taskId: number, userIds: number[]): Promise<void> {
    const client = await getClientFromContext();

    // Remove users from the task with retry logic
    for (const userId of userIds) {
      try {
        await withRetry(
          () => client.tasks.removeUserFromTask(taskId, userId),
          {
            ...RETRY_CONFIG.AUTH_ERRORS,
            shouldRetry: (error) => isRetryableAuthError(error),
          },
        );
      } catch (removeError) {
        // A genuinely retryable auth error (401) was retried and still failed.
        if (isRetryableAuthError(removeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            assigneeAuthMessage(AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE, removeError, true),
          );
        }
        // A 403 (or any other non-retryable auth error) fails fast — say so honestly.
        if (isAuthenticationError(removeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            assigneeAuthMessage(AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE, removeError, false),
          );
        }
        throw removeError;
      }
    }
  },

  /**
   * Fetch task data to get current assignees
   */
  async fetchTaskWithAssignees(taskId: number): Promise<TaskWithAssignees> {
    const client = await getClientFromContext();
    const task = await client.tasks.getTask(taskId);
    // Ensure required properties exist for TaskWithAssignees
    if (!task.id) {
      throw new MCPError(ErrorCode.INTERNAL_ERROR, 'Task returned from API is missing required id field');
    }
    return {
      ...task,
      id: task.id,
      title: task.title || '',
      assignees: task.assignees || [],
    };
  },

  /**
   * Extract assignee information from task
   */
  extractAssignees(task: TaskWithAssignees): Assignee[] {
    return task.assignees || [];
  },

  /**
   * Create minimal task representation with assignees
   */
  createMinimalTaskWithAssignees(task: TaskWithAssignees): MinimalTask {
    const assignees = AssigneeOperationsService.extractAssignees(task);

    return {
      ...(task.id !== undefined && { id: task.id }),
      title: task.title,
      assignees: assignees,
    };
  },

  /**
   * Re-fetch the task and return requested IDs that did not persist.
   * Empty result means either all stuck, or verification itself failed (fail-open).
   */
  async verifyAssignees(taskId: number, requestedIds: number[]): Promise<number[]> {
    try {
      const task = await AssigneeOperationsService.fetchTaskWithAssignees(taskId);
      return findMissingAssigneeIds(task.assignees, requestedIds);
    } catch {
      // If we can't verify, don't block — return empty (assume OK)
      return [];
    }
  },
};
