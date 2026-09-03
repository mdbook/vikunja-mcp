import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { handleComment, updateComment, deleteComment, listComments } from '../../../src/tools/tasks/comments';
import { getClientFromContext } from '../../../src/client';
import { MCPError, ErrorCode } from '../../../src/types';
import { parseMarkdown } from '../../utils/markdown';

jest.mock('../../../src/client');
jest.mock('../../../src/utils/logger');

describe('Comment operations', () => {
  const mockClient = {
    tasks: {
      createTaskComment: jest.fn(),
      getTaskComments: jest.fn(),
      updateTaskComment: jest.fn(),
      deleteTaskComment: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getClientFromContext as jest.Mock).mockResolvedValue(mockClient);
  });

  describe('handleComment', () => {
    it('should create a comment successfully', async () => {
      const mockComment = {
        id: 1,
        comment: 'Test comment',
        created: new Date().toISOString(),
      };
      mockClient.tasks.createTaskComment.mockResolvedValue(mockComment);

      const result = await handleComment({
        id: 123,
        comment: 'Test comment',
      });

      expect(mockClient.tasks.createTaskComment).toHaveBeenCalledWith(123, {
        comment: 'Test comment',
        task_id: 123,
      });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('comment');
      expect(markdown).toContain('Comment added successfully');
    });

    it('should throw when comment text is missing (no silent list fallback)', async () => {
      await expect(handleComment({ id: 123 })).rejects.toThrow(
        'Failed to handle comment: comment text is required for the comment operation'
      );

      // Must NOT silently fall through to listing comments
      expect(mockClient.tasks.getTaskComments).not.toHaveBeenCalled();
    });

    it('should throw error when id is missing', async () => {
      await expect(handleComment({ comment: 'Test' })).rejects.toThrow(
        'Failed to handle comment: Task id is required for comment operation'
      );
    });

    it('should throw error when id is zero', async () => {
      // id: 0 is falsy, so it's treated as missing
      await expect(handleComment({ id: 0, comment: 'Test' })).rejects.toThrow(
        'Failed to handle comment: Task id is required for comment operation'
      );
    });

    it('should throw error when id is negative', async () => {
      // Negative IDs fail validation
      await expect(handleComment({ id: -1, comment: 'Test' })).rejects.toThrow(
        'Failed to handle comment: id must be a positive integer'
      );
    });

    it('should handle API errors when creating comment', async () => {
      mockClient.tasks.createTaskComment.mockRejectedValue(new Error('API Error'));

      await expect(handleComment({ id: 123, comment: 'Test' })).rejects.toThrow(
        'Failed to handle comment: API Error'
      );
    });

    it('should throw when an empty string is provided (no silent list fallback)', async () => {
      await expect(
        handleComment({ id: 123, comment: '' })
      ).rejects.toThrow(
        'Failed to handle comment: comment text is required for the comment operation'
      );

      expect(mockClient.tasks.getTaskComments).not.toHaveBeenCalled();
      expect(mockClient.tasks.createTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when only whitespace is provided (no silent list fallback)', async () => {
      await expect(
        handleComment({ id: 123, comment: '   ' })
      ).rejects.toThrow(
        'Failed to handle comment: comment text is required for the comment operation'
      );

      expect(mockClient.tasks.getTaskComments).not.toHaveBeenCalled();
      expect(mockClient.tasks.createTaskComment).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('should update (edit) a comment successfully', async () => {
      const mockComment = {
        id: 7,
        task_id: 123,
        comment: 'Edited text',
        updated: new Date().toISOString(),
      };
      mockClient.tasks.updateTaskComment.mockResolvedValue(mockComment);

      const result = await updateComment({
        id: 123,
        commentId: 7,
        comment: 'Edited text',
      });

      expect(mockClient.tasks.updateTaskComment).toHaveBeenCalledWith(123, 7, {
        id: 7,
        task_id: 123,
        comment: 'Edited text',
      });

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Comment updated successfully');
    });

    it('should throw when task id is missing', async () => {
      await expect(updateComment({ commentId: 7, comment: 'x' })).rejects.toThrow(
        'Task id is required for update-comment operation'
      );
      expect(mockClient.tasks.updateTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when commentId is missing', async () => {
      await expect(updateComment({ id: 123, comment: 'x' })).rejects.toThrow(
        'commentId is required for update-comment operation'
      );
      expect(mockClient.tasks.updateTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when new comment text is missing', async () => {
      await expect(updateComment({ id: 123, commentId: 7 })).rejects.toThrow(
        'comment text is required for the update-comment operation'
      );
      expect(mockClient.tasks.updateTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when new comment text is only whitespace', async () => {
      await expect(
        updateComment({ id: 123, commentId: 7, comment: '   ' })
      ).rejects.toThrow('comment text is required for the update-comment operation');
      expect(mockClient.tasks.updateTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when commentId is negative', async () => {
      await expect(
        updateComment({ id: 123, commentId: -1, comment: 'x' })
      ).rejects.toThrow('commentId must be a positive integer');
    });

    it('should surface API errors', async () => {
      mockClient.tasks.updateTaskComment.mockRejectedValue(new Error('API Error'));
      await expect(
        updateComment({ id: 123, commentId: 7, comment: 'x' })
      ).rejects.toThrow('Failed to update comment: API Error');
    });
  });

  describe('deleteComment', () => {
    it('should delete a comment successfully', async () => {
      mockClient.tasks.deleteTaskComment.mockResolvedValue({ message: 'Successfully deleted.' });

      const result = await deleteComment({ id: 123, commentId: 7 });

      expect(mockClient.tasks.deleteTaskComment).toHaveBeenCalledWith(123, 7);

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Comment 7 deleted successfully');
    });

    it('should throw when task id is missing', async () => {
      await expect(deleteComment({ commentId: 7 })).rejects.toThrow(
        'Task id is required for delete-comment operation'
      );
      expect(mockClient.tasks.deleteTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when commentId is missing', async () => {
      await expect(deleteComment({ id: 123 })).rejects.toThrow(
        'commentId is required for delete-comment operation'
      );
      expect(mockClient.tasks.deleteTaskComment).not.toHaveBeenCalled();
    });

    it('should throw when commentId is negative', async () => {
      await expect(deleteComment({ id: 123, commentId: -1 })).rejects.toThrow(
        'commentId must be a positive integer'
      );
    });

    it('should surface API errors', async () => {
      mockClient.tasks.deleteTaskComment.mockRejectedValue(new Error('API Error'));
      await expect(deleteComment({ id: 123, commentId: 7 })).rejects.toThrow(
        'Failed to delete comment: API Error'
      );
    });
  });

  describe('listComments', () => {
    it('should list comments successfully', async () => {
      const mockComments = [
        { id: 1, comment: 'First comment', created: '2024-01-01' },
        { id: 2, comment: 'Second comment', created: '2024-01-02' },
      ];
      mockClient.tasks.getTaskComments.mockResolvedValue(mockComments);

      const result = await listComments({ id: 123 });

      expect(mockClient.tasks.getTaskComments).toHaveBeenCalledWith(123);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('list');
      expect(markdown).toContain('Found 2 comments');
    });

    it('should throw error when id is missing', async () => {
      await expect(listComments({})).rejects.toThrow(
        'Failed to list comments: Task id is required for list-comments operation'
      );
    });

    it('should throw error when id is invalid', async () => {
      await expect(listComments({ id: -1 })).rejects.toThrow(
        'Failed to list comments: id must be a positive integer'
      );
    });

    it('should handle empty comments list', async () => {
      mockClient.tasks.getTaskComments.mockResolvedValue([]);

      const result = await listComments({ id: 123 });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('list');
      expect(markdown).toContain('Found 0 comments');
    });

    it('should handle API errors', async () => {
      mockClient.tasks.getTaskComments.mockRejectedValue(new Error('API Error'));

      await expect(listComments({ id: 123 })).rejects.toThrow(
        'Failed to list comments: API Error'
      );
    });
  });
});