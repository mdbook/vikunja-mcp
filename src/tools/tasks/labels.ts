/**
 * Label operations for tasks
 */

import type { MinimalTask } from '../../types';
import { MCPError, ErrorCode } from '../../types';
import { getClientFromContext } from '../../client';
import type { VikunjaClient } from 'node-vikunja';
import { isAuthenticationError, isRetryableAuthError } from '../../utils/auth-error-handler';
import { withRetry, RETRY_CONFIG } from '../../utils/retry';
import { validateId } from './validation';
import { createSimpleResponse, formatAorpAsMarkdown } from '../../utils/response-factory';

/**
 * Build an honest error message for a non-retryable auth error (typically 403 — a
 * permanent permission denial, as opposed to a 401 that a retry might clear).
 * Includes the real HTTP status when the error carries one, instead of the previous
 * blanket "(Retried N times)" message, which lied about a 403 that was never retried.
 */
function nonRetryableAuthMessage(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errorWithStatus = error as { status?: number; response?: { status?: number } };
  const status = errorWithStatus?.status ?? errorWithStatus?.response?.status;
  const statusNote = status
    ? `HTTP ${status} — the Vikunja service token likely lacks permission for this operation`
    : 'the Vikunja service token likely lacks permission for this operation';
  return `${prefix}: ${message} (${statusNote})`;
}

/**
 * Detect a 403/Forbidden error robustly (numeric status, axios-style response.status,
 * or a "forbidden" message — case-insensitive).
 *
 * Confirmed by controlled experiment (2x): `DELETE /tasks/{id}/labels/{labelId}` is
 * NOT idempotent on Vikunja's side — removing a label that IS currently on the task
 * returns 200, but removing one that is NOT on the task (already absent) returns 403.
 * It is not a token-permission problem; it is Vikunja's non-idempotent-delete quirk.
 * So for `removeLabels`, a 403 means the label is already in the desired end state and
 * must be treated as a benign no-op, not an error.
 */
function isForbiddenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorWithStatus = error as Error & { status?: number; response?: { status?: number } };
  if (errorWithStatus.status === 403 || errorWithStatus.response?.status === 403) {
    return true;
  }
  return error.message.toLowerCase().includes('forbidden');
}

/**
 * Applies labels to a task WITHOUT destroying the ones it already has.
 *
 * Two chained bugs made the previous path lose data. Both verified against a live
 * Vikunja v2.4.0 instance:
 *
 *   1) UNUSABLE PAYLOAD. `node-vikunja`'s `updateTaskLabels` posts `{label_ids: [...]}`
 *      to `/tasks/{id}/labels/bulk`, but the model Vikunja declares for that endpoint is
 *      `{labels: [...]}` (see `LabelTaskBulk` in the server's OpenAPI). The unknown field
 *      is discarded, the server reads an EMPTY label list, and dutifully applies it: it
 *      removes every label and adds none — while answering `201`.
 *
 *   2) REPLACE SEMANTICS. Even with a working payload, the bulk endpoint replaces the
 *      whole set, so any label not repeated in the call is dropped. A caller that only
 *      wants to add one label has no way to know what else is on the task.
 *
 *   Reproduction: a task carrying labels 2 and 4, updated with `labels: [3]`, ended up
 *   with NONE — the two it had were gone and the requested one was never applied, and the
 *   operation reported success.
 *
 * The fix drops the bulk endpoint for the INDIVIDUAL one (`PUT /tasks/{id}/labels`, which
 * returns 201 and actually applies), one call per label, over the UNION with what the task
 * already had. There is precedent in this codebase: assignees moved to one-by-one calls
 * for the same kind of reason (see AssigneeOperationsService).
 *
 * Resulting semantics: labels are ADDED, never removed. `remove-label` removes them.
 * One deliberate consequence: `labels: []` no longer empties a task — it is a no-op. That
 * used to be the way to clear all labels, but it was also the way to lose them by accident.
 *
 * @param currentLabelIds labels the task already carries. Read from the server if omitted.
 *        Callers that have just CREATED the task pass `[]` and skip the read.
 * @returns what was added and what was kept, so the caller can report it without guessing.
 */
export async function addLabelsToTaskAdditive(
  client: VikunjaClient,
  taskId: number,
  labelIds: number[],
  options: { currentLabelIds?: number[] } = {},
): Promise<{ added: number[]; kept: number[] }> {
  let kept = options.currentLabelIds;
  if (kept === undefined) {
    const currentTask = await client.tasks.getTask(taskId);
    kept = (currentTask.labels ?? [])
      .map((label) => label.id)
      .filter((id): id is number => typeof id === 'number');
  }

  // Only the missing ones are requested: re-applying one that is already there returns
  // 400 ("label already exists on task") and would abort the rest of the batch for nothing.
  const requested = [...new Set(labelIds)];
  const toAdd = requested.filter((id) => !kept.includes(id));

  for (const labelId of toAdd) {
    await withRetry(
      () =>
        client.tasks.addLabelToTask(taskId, {
          task_id: taskId,
          label_id: labelId,
        }),
      {
        ...RETRY_CONFIG.AUTH_ERRORS,
        shouldRetry: (error: unknown) => isRetryableAuthError(error),
      },
    );
  }

  return { added: toAdd, kept };
}

/**
 * Add labels to a task
 *
 * Semantics: ADD. Labels the task already had are preserved.
 */
export async function applyLabels(args: {
  id?: number;
  labels?: number[];
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for apply-label operation',
      );
    }
    validateId(args.id, 'id');

    if (!args.labels || args.labels.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'At least one label id is required');
    }

    // Validate label IDs
    args.labels.forEach((id) => validateId(id, 'label ID'));

    const client = await getClientFromContext();
    const taskId = args.id;
    const labelIds = args.labels;

    // Delegates to `addLabelsToTaskAdditive`, which reads the current labels and only
    // requests the missing ones.
    //
    // This loop used to request all of them and throw on the first error. Vikunja returns
    // 400 ("This label already exists on the task") when one is already applied, so
    // `apply-label [2, 4]` on a task that already had 2 ABORTED, and 4 was never applied.
    // Asking for something that is already true is not an error: it is a no-op.
    try {
      await addLabelsToTaskAdditive(client, taskId, labelIds, {
      });
    } catch (labelError) {
      // A genuinely retryable auth error (401) was retried and still failed.
      if (isRetryableAuthError(labelError)) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Failed to apply label to task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
        );
      }
      // A 403 (or any other non-retryable auth error) fails fast — say so honestly
      // instead of claiming a retry that never happened.
      if (isAuthenticationError(labelError)) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          nonRetryableAuthMessage('Failed to apply label to task', labelError),
        );
      }
      throw labelError;
    }

    // Fetch the updated task to show current labels
    const task = await client.tasks.getTask(args.id);

    const response = createSimpleResponse(
      'apply-label',
      `Label${labelIds.length > 1 ? 's' : ''} applied to task successfully`,
      { task },
      { metadata: { affectedFields: ['labels'] } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to apply labels to task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Remove labels from a task
 */
export async function removeLabels(args: {
  id?: number;
  labels?: number[];
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for remove-label operation',
      );
    }
    validateId(args.id, 'id');

    if (!args.labels || args.labels.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'At least one label id is required to remove');
    }

    // Validate label IDs
    args.labels.forEach((id) => validateId(id, 'label ID'));

    const client = await getClientFromContext();
    const taskId = args.id;
    const labelIds = args.labels;

    // Remove labels from the task with retry logic
    const alreadyAbsent: number[] = [];
    for (const labelId of labelIds) {
      try {
        await withRetry(() => client.tasks.removeLabelFromTask(taskId, labelId), {
          ...RETRY_CONFIG.AUTH_ERRORS,
          shouldRetry: (error: unknown) => isRetryableAuthError(error),
        });
      } catch (removeError) {
        // Vikunja's DELETE is not idempotent: removing a label that is already absent
        // returns 403, not a 404/no-op. That is the desired end state already reached —
        // treat it as success, not an error, and move on to the next label.
        if (isForbiddenError(removeError)) {
          alreadyAbsent.push(labelId);
          continue;
        }
        // A genuinely retryable auth error (401) was retried and still failed.
        if (isRetryableAuthError(removeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            `Failed to remove label from task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
          );
        }
        // Any other non-retryable auth error fails fast — say so honestly instead of
        // claiming a retry that never happened.
        if (isAuthenticationError(removeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            nonRetryableAuthMessage('Failed to remove label from task', removeError),
          );
        }
        throw removeError;
      }
    }

    // Fetch the updated task to show current labels
    const task = await client.tasks.getTask(args.id);

    const allAlreadyAbsent = alreadyAbsent.length === labelIds.length;
    const successMessage = allAlreadyAbsent
      ? `Label${labelIds.length > 1 ? 's' : ''} already absent from task (no-op)`
      : alreadyAbsent.length > 0
        ? `Label${labelIds.length > 1 ? 's' : ''} removed from task successfully (some were already absent)`
        : `Label${labelIds.length > 1 ? 's' : ''} removed from task successfully`;

    const response = createSimpleResponse(
      'remove-label',
      successMessage,
      { task },
      { metadata: { affectedFields: ['labels'] } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to remove labels from task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * List labels of a task
 */
export async function listTaskLabels(args: {
  id?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (args.id === undefined) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for list-labels operation',
      );
    }
    validateId(args.id, 'id');

    const client = await getClientFromContext();

    // Fetch the task to get current labels
    const task = await client.tasks.getTask(args.id);

    const labels = task.labels || [];

    const minimalTask: MinimalTask = {
      ...(task.id !== undefined && { id: task.id }),
      title: task.title,
    };

    const response = createSimpleResponse(
      'list-labels',
      `Task has ${labels.length} label(s)`,
      { task: { ...minimalTask, labels: labels } },
      { metadata: { count: labels.length } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to list task labels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
