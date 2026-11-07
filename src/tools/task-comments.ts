/**
 * Task Comments Tool
 * Handles task comment operations: comment, list
 * Replaces monolithic tasks tool with focused individual tool
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { createAuthRequiredError } from '../utils/error-handler';
import { handleComment, listComments, updateComment, deleteComment } from '../tools/tasks/comments/index';

/**
 * Register task comments tool
 */
export function registerTaskCommentsTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  server.tool(
    'vikunja_task_comments',
    'Manage task comments: add (comment), list, update (edit an existing comment), or delete a comment. '
      + 'update requires id + commentId + comment (new text); delete requires id + commentId. '
      + 'list returns all comments by default, oldest first; page/perPage select a page and newestFirst reverses the global order. Includes total count.',
    {
      operation: z.enum(['comment', 'list', 'update', 'delete']),
      // Task and comment identification
      id: z.number(),
      comment: z.string().optional(),
      commentId: z.number().optional(),
      page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
        .describe('List only: 1-based page; omit to return all comments'),
      perPage: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
        .describe('List only: page size (default 50); without page, returns all comments'),
      newestFirst: z.boolean().optional().describe('List only: newest comments first (default false)'),
    },
    async (args) => {
      try {
        logger.debug('Executing task comments tool', { operation: args.operation, taskId: args.id });

        // Check authentication
        if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task comment operations');
        }

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getClientFromContext();

        switch (args.operation) {
          case 'comment':
            return await handleComment({
              id: args.id,
              ...(args.comment !== undefined ? { comment: args.comment } : {}),
            });

          case 'list':
            return await listComments({
              id: args.id,
              ...(args.page !== undefined ? { page: args.page } : {}),
              ...(args.perPage !== undefined ? { perPage: args.perPage } : {}),
              ...(args.newestFirst !== undefined ? { newestFirst: args.newestFirst } : {}),
            });

          case 'update':
            return await updateComment({
              id: args.id,
              ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
              ...(args.comment !== undefined ? { comment: args.comment } : {}),
            });

          case 'delete':
            return await deleteComment({
              id: args.id,
              ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
            });

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
          `Task comment operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
