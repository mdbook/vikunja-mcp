/**
 * Task Relations Extensions
 * Handles task relation operations for Vikunja
 */

import { z } from 'zod';
import { MCPError, ErrorCode, type StandardTaskResponse } from '../types';
import { getClientFromContext } from '../client';
import { logger } from '../utils/logger';
import { validateId as validateSharedId } from '../utils/validation';
import { wrapToolError } from '../utils/error-handler';
import type { RelationKind } from 'node-vikunja';
import { formatAorpAsMarkdown, createStandardResponse } from '../utils/response-factory';

// Use shared validateId from utils/validation

// Relation kind mapping - matches the node-vikunja RelationKind enum
const RELATION_KIND_MAP: Record<string, string> = {
  unknown: 'unknown',
  subtask: 'subtask',
  parenttask: 'parenttask',
  related: 'related',
  duplicateof: 'duplicateof',
  duplicates: 'duplicates',
  blocking: 'blocking',
  blocked: 'blocked',
  precedes: 'precedes',
  follows: 'follows',
  copiedfrom: 'copiedfrom',
  copiedto: 'copiedto',
};

export const relationSchema = {
  // Relation fields
  otherTaskId: z.number().optional(),
  relationKind: z
    .enum([
      'unknown',
      'subtask',
      'parenttask',
      'related',
      'duplicateof',
      'duplicates',
      'blocking',
      'blocked',
      'precedes',
      'follows',
      'copiedfrom',
      'copiedto',
    ])
    .optional(),
};

export const relationSubcommands = ['relate', 'unrelate', 'relations'];

interface RelationArgs {
  subcommand: string;
  id?: number | undefined;
  otherTaskId?: number | undefined;
  relationKind?: string | undefined;
}

/** A single related task, normalized across the array/map API shapes. */
export interface NormalizedRelatedTask {
  id: number;
  title?: string;
}

/** Related tasks grouped by relation kind. */
export interface RelationGroup {
  kind: string;
  tasks: NormalizedRelatedTask[];
}

/** Cap on the number of title lookups performed to enrich relations, so a
 *  heavily-related task can't fan out into an unbounded number of API calls. */
const MAX_TITLE_LOOKUPS = 50;

/**
 * Normalize a task's `related_tasks` into groups keyed by relation kind.
 *
 * Vikunja's live API returns `related_tasks` as a MAP keyed by relation kind
 * (`{ "subtask": [ {..task..} ], "blocking": [ {..task..} ] }`), where each
 * value is an array of full related Task objects. node-vikunja's type instead
 * claims a FLAT array of `{ task_id, relation_kind }`. Both shapes (and
 * null/undefined) are handled defensively so counting/rendering never depends
 * on the wrong shape (the old `related_tasks.length` was `undefined` on the map
 * → always reported "0 relations").
 */
export function normalizeRelatedTasks(related: unknown): {
  groups: RelationGroup[];
  total: number;
} {
  if (!related || typeof related !== 'object') {
    return { groups: [], total: 0 };
  }

  const groupMap = new Map<string, NormalizedRelatedTask[]>();

  const pushEntry = (kind: string, entry: NormalizedRelatedTask): void => {
    const list = groupMap.get(kind) ?? [];
    list.push(entry);
    groupMap.set(kind, list);
  };

  if (Array.isArray(related)) {
    // Flat-array shape: [{ task_id, relation_kind }, ...]
    for (const raw of related) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { task_id?: number; id?: number; relation_kind?: string; title?: string };
      const id = item.task_id ?? item.id;
      if (typeof id !== 'number') continue;
      const kind = item.relation_kind ?? 'unknown';
      const entry: NormalizedRelatedTask = { id };
      if (typeof item.title === 'string') entry.title = item.title;
      pushEntry(kind, entry);
    }
  } else {
    // Map shape: { <relation_kind>: [ {..task..}, ... ], ... }
    for (const [kind, value] of Object.entries(related as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as { id?: number; task_id?: number; title?: string };
        const id = item.id ?? item.task_id;
        if (typeof id !== 'number') continue;
        const entry: NormalizedRelatedTask = { id };
        if (typeof item.title === 'string') entry.title = item.title;
        pushEntry(kind, entry);
      }
    }
  }

  const groups: RelationGroup[] = [];
  let total = 0;
  for (const [kind, tasks] of groupMap.entries()) {
    if (tasks.length === 0) continue;
    groups.push({ kind, tasks });
    total += tasks.length;
  }

  return { groups, total };
}

/** Render relation groups as readable, grouped markdown. */
export function formatRelationGroups(groups: RelationGroup[]): string {
  if (groups.length === 0) {
    return '_No relations._';
  }
  return groups
    .map((group) => {
      const lines = group.tasks
        .map((t) => `  - #${t.id}${t.title ? ` ${t.title}` : ''}`)
        .join('\n');
      return `- **${group.kind}** (${group.tasks.length}):\n${lines}`;
    })
    .join('\n');
}

export async function handleRelationSubcommands(
  args: RelationArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const client = await getClientFromContext();

  switch (args.subcommand) {
    case 'relate': {
      try {
        if (!args.id) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required');
        }
        validateSharedId(args.id, 'Task ID');

        if (!args.otherTaskId) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Other task ID is required');
        }
        validateSharedId(args.otherTaskId, 'Other task ID');

        if (!args.relationKind) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Relation kind is required');
        }

        const relationKind = RELATION_KIND_MAP[args.relationKind];
        if (!relationKind) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid relation kind: ${args.relationKind}`,
          );
        }

        // Create the relation
        await client.tasks.createTaskRelation(args.id, {
          task_id: args.id,
          other_task_id: args.otherTaskId,
          relation_kind: relationKind as RelationKind,
        });

        // Fetch the updated task to show all relations
        const updatedTask = await client.tasks.getTask(args.id);

        const response: StandardTaskResponse = {
          success: true,
          operation: 'relate',
          message: `Successfully created ${args.relationKind} relation between task ${args.id} and task ${args.otherTaskId}`,
          task: updatedTask,
          metadata: {
            timestamp: new Date().toISOString(),
            affectedFields: ['related_tasks'],
          },
        };

        logger.debug('Task relation created', {
          taskId: args.id,
          otherTaskId: args.otherTaskId,
          relationKind: args.relationKind,
        });

        // Convert StandardTaskResponse to proper AORP response before formatting
        const aorpResponse = createStandardResponse(
          response.operation || 'unknown',
          response.message || 'Operation completed',
          response,
          response.metadata as Record<string, unknown>
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: formatAorpAsMarkdown(aorpResponse),
            },
          ],
        };
      } catch (error) {
        throw wrapToolError(error, 'vikunja_tasks_relations', 'create task relation', `${args.id}-${args.otherTaskId}`);
      }
    }

    case 'unrelate': {
      try {
        if (!args.id) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required');
        }
        validateSharedId(args.id, 'Task ID');

        if (!args.otherTaskId) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Other task ID is required');
        }
        validateSharedId(args.otherTaskId, 'Other task ID');

        if (!args.relationKind) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Relation kind is required');
        }

        const relationKind = RELATION_KIND_MAP[args.relationKind];
        if (!relationKind) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid relation kind: ${args.relationKind}`,
          );
        }

        // Delete the relation
        await client.tasks.deleteTaskRelation(
          args.id,
          relationKind as RelationKind,
          args.otherTaskId,
        );

        // Fetch the updated task to show remaining relations
        const updatedTask = await client.tasks.getTask(args.id);

        const response: StandardTaskResponse = {
          success: true,
          operation: 'unrelate',
          message: `Successfully removed ${args.relationKind} relation between task ${args.id} and task ${args.otherTaskId}`,
          task: updatedTask,
          metadata: {
            timestamp: new Date().toISOString(),
            affectedFields: ['related_tasks'],
          },
        };

        logger.debug('Task relation removed', {
          taskId: args.id,
          otherTaskId: args.otherTaskId,
          relationKind: args.relationKind,
        });

        // Convert StandardTaskResponse to proper AORP response before formatting
        const aorpResponse = createStandardResponse(
          response.operation || 'unknown',
          response.message || 'Operation completed',
          response,
          response.metadata as Record<string, unknown>
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: formatAorpAsMarkdown(aorpResponse),
            },
          ],
        };
      } catch (error) {
        throw wrapToolError(error, 'vikunja_tasks_relations', 'remove task relation', `${args.id}-${args.otherTaskId}`);
      }
    }

    case 'relations': {
      try {
        if (!args.id) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required');
        }
        validateSharedId(args.id, 'Task ID');

        // Fetch the task with its relations
        const task = await client.tasks.getTask(args.id);

        // Normalize across the map/array API shapes (see normalizeRelatedTasks).
        const { groups, total } = normalizeRelatedTasks(
          (task as { related_tasks?: unknown }).related_tasks,
        );

        // Enrich missing titles with a bounded set of getTask lookups. The map
        // shape already carries titles; the flat-array shape carries only ids.
        let lookups = 0;
        for (const group of groups) {
          for (const rel of group.tasks) {
            if (rel.title !== undefined) continue;
            if (lookups >= MAX_TITLE_LOOKUPS) break;
            lookups += 1;
            try {
              const relatedTask = await client.tasks.getTask(rel.id);
              if (relatedTask && typeof relatedTask.title === 'string') {
                rel.title = relatedTask.title;
              }
            } catch (lookupError) {
              // A failed title lookup is non-fatal: keep the id-only entry.
              logger.debug('Relation title lookup failed', {
                relatedTaskId: rel.id,
                error: lookupError instanceof Error ? lookupError.message : String(lookupError),
              });
            }
          }
        }

        const groupedMarkdown = formatRelationGroups(groups);
        const message =
          `Found ${total} relations for task ${args.id}` +
          (total > 0 ? `:\n\n${groupedMarkdown}` : '');

        const response: StandardTaskResponse = {
          success: true,
          operation: 'relations',
          message,
          // Return the normalized, grouped relations rather than the raw task
          // blob so the output is readable and machine-parseable.
          metadata: {
            timestamp: new Date().toISOString(),
            count: total,
          },
        };

        logger.debug('Task relations retrieved', {
          taskId: args.id,
          relationCount: total,
          groupCount: groups.length,
        });

        // Convert StandardTaskResponse to proper AORP response before formatting
        const aorpResponse = createStandardResponse(
          response.operation || 'unknown',
          response.message || 'Operation completed',
          response,
          response.metadata as Record<string, unknown>
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: formatAorpAsMarkdown(aorpResponse),
            },
          ],
        };
      } catch (error) {
        throw wrapToolError(error, 'vikunja_tasks_relations', 'get task relations', args.id);
      }
    }

    default:
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid relation subcommand');
  }
}
