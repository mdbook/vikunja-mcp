/**
 * Comment operations service
 * Handles core business logic for task comment management
 */

import type { TaskComment, Message } from '../../../types/vikunja';
import { getClientFromContext } from '../../../client';

// Use the same request seam as patchGetAllTasks: explicitly forward API query
// parameters rather than relying on the SDK's unpaginated comment helper.
interface CommentServiceWithRequest {
  request(
    endpoint: string,
    method: string,
    body: undefined,
    options: { params: { page: number; per_page: number } },
  ): Promise<TaskComment[]>;
}

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
    const tasks = client.tasks as unknown as CommentServiceWithRequest;
    const comments: TaskComment[] = [];
    // Read through an empty page, not merely a short page: servers can cap
    // per_page below the requested size. Never silently drop later comments.
    for (let page = 1; ; page++) {
      const batch = await tasks.request(`/tasks/${taskId}/comments`, 'GET', undefined, {
        params: { page, per_page: 50 },
      });
      if (!batch || batch.length === 0) {
        return comments;
      }
      comments.push(...batch);
    }
  },

  /**
   * Get comment count from comments array
   */
  getCommentCount(comments: TaskComment[]): number {
    return comments.length;
  },
};
