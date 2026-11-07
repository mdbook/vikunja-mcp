/**
 * Comment operations for tasks
 * Refactored to use modular service architecture
 */

import { MCPError, ErrorCode } from '../../../types';
import { CommentOperationsService } from './CommentOperationsService';
import { commentValidationService } from './CommentValidationService';
import { commentResponseFormatter } from './CommentResponseFormatter';

/**
 * Add a comment to a task or list task comments
 */
export async function handleComment(args: {
  id?: number;
  comment?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { taskId, commentText } = commentValidationService.validateCommentInput(args);

    // The comment operation requires comment text. Reject missing/empty/whitespace-only
    // text instead of silently falling through to a list (listing is handled separately
    // via listComments / the 'list' operation).
    if (!commentValidationService.shouldCreateComment(commentText)) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'comment text is required for the comment operation',
      );
    }

    // Create a new comment (commentText is guaranteed present here; narrow for the type-checker)
    if (!commentText) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'comment text is required for the comment operation',
      );
    }
    const newComment = await CommentOperationsService.createComment(taskId, commentText);

    // Format and return response
    const response = commentResponseFormatter.formatCreateCommentResponse(newComment);
    return commentResponseFormatter.formatMcpResponse(response);

  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to handle comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Update (edit) an existing comment on a task.
 *
 * node-vikunja 0.4.0 supports editing task comments natively
 * (POST /tasks/{taskId}/comments/{commentId}), so this is a real operation.
 */
export async function updateComment(args: {
  id?: number;
  commentId?: number;
  comment?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { taskId, commentId, commentText } = commentValidationService.validateUpdateInput(args);

    const updatedComment = await CommentOperationsService.updateComment(
      taskId,
      commentId,
      commentText,
    );

    const response = commentResponseFormatter.formatUpdateCommentResponse(updatedComment);
    return commentResponseFormatter.formatMcpResponse(response);

  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to update comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Delete a comment from a task.
 *
 * node-vikunja 0.4.0 supports deleting task comments natively
 * (DELETE /tasks/{taskId}/comments/{commentId}), so this is a real operation.
 */
export async function deleteComment(args: {
  id?: number;
  commentId?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { taskId, commentId } = commentValidationService.validateDeleteInput(args);

    await CommentOperationsService.deleteComment(taskId, commentId);

    const response = commentResponseFormatter.formatDeleteCommentResponse(taskId, commentId);
    return commentResponseFormatter.formatMcpResponse(response);

  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to delete comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * List all comments for a task
 */
export async function listComments(args: {
  id?: number;
  page?: number;
  perPage?: number;
  newestFirst?: boolean;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { taskId } = commentValidationService.validateListInput(args);
    for (const key of ['page', 'perPage'] as const) {
      const value = args[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new MCPError(ErrorCode.VALIDATION_ERROR, `${key} must be a positive safe integer`);
      }
    }

    const comments = await CommentOperationsService.fetchTaskComments(taskId);
    const total = comments.length;
    // Vikunja returns comments oldest first. Reverse before slicing so page 1
    // in newest-first mode contains the latest instructions, not the oldest page.
    if (args.newestFirst) {
      comments.reverse();
    }
    const perPage = args.perPage ?? 50;
    const start = args.page === undefined ? 0 : (args.page - 1) * perPage;
    const selected = args.page === undefined ? comments : comments.slice(start, start + perPage);

    // Format and return response
    const response = commentResponseFormatter.formatListCommentsResponse(selected, total);
    return commentResponseFormatter.formatMcpResponse(response);

  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to list comments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
