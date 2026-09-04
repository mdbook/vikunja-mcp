/**
 * Comment operations service
 * Handles core business logic for task comment management
 */

import type { TaskComment, Message } from '../../../types/vikunja';
import { getClientFromContext } from '../../../client';

/**
 * Service for managing task comment operations
 */
export const CommentOperationsService = {
  /**
   * Create a new comment on a task
   */
  async createComment(taskId: number, commentText: string): Promise<TaskComment> {
    const client = await getClientFromContext();
    return await client.tasks.createTaskComment(taskId, {
      task_id: taskId,
      comment: commentText,
    });
  },

  /**
   * Update (edit) an existing comment on a task.
   *
   * node-vikunja 0.4.0 maps this to `POST /tasks/{taskId}/comments/{commentId}`
   * (Vikunja's edit-comment verb). Supported natively by the client, so no raw
   * request shim is needed.
   */
  async updateComment(taskId: number, commentId: number, commentText: string): Promise<TaskComment> {
    const client = await getClientFromContext();
    return await client.tasks.updateTaskComment(taskId, commentId, {
      id: commentId,
      task_id: taskId,
      comment: commentText,
    });
  },

  /**
   * Delete a comment from a task.
   *
   * node-vikunja 0.4.0 maps this to `DELETE /tasks/{taskId}/comments/{commentId}`
   * and returns a `{ message }` payload. Supported natively by the client.
   */
  async deleteComment(taskId: number, commentId: number): Promise<Message> {
    const client = await getClientFromContext();
    return await client.tasks.deleteTaskComment(taskId, commentId);
  },

  /**
   * Fetch all comments for a task
   */
  async fetchTaskComments(taskId: number): Promise<TaskComment[]> {
    const client = await getClientFromContext();
    return await client.tasks.getTaskComments(taskId);
  },

  /**
   * Get comment count from comments array
   */
  getCommentCount(comments: TaskComment[]): number {
    return comments.length;
  },
};