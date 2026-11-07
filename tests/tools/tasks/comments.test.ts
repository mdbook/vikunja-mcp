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
      request: jest.fn(),
      updateTaskComment: jest.fn(),
      deleteTaskComment: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.tasks.request.mockReset();
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
      mockClient.tasks.request.mockResolvedValueOnce(mockComments).mockResolvedValueOnce([]);

      const result = await listComments({ id: 123 });

      expect(mockClient.tasks.request).toHaveBeenNthCalledWith(
        1, '/tasks/123/comments', 'GET', undefined, { params: { page: 1, per_page: 50 } },
      );
      expect(mockClient.tasks.request).toHaveBeenNthCalledWith(
        2, '/tasks/123/comments', 'GET', undefined, { params: { page: 2, per_page: 50 } },
      );

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
      mockClient.tasks.request.mockResolvedValue([]);

      const result = await listComments({ id: 123 });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('list');
      expect(markdown).toContain('Found 0 comments');
      expect(markdown).toContain('**total:** 0');
      expect(mockClient.tasks.request).toHaveBeenCalledTimes(1);
    });

    it('should handle API errors', async () => {
      mockClient.tasks.request.mockRejectedValue(new Error('API Error'));

      await expect(listComments({ id: 123 })).rejects.toThrow(
        'Failed to list comments: API Error'
      );
    });

    it('treats a null API list as empty', async () => {
      mockClient.tasks.request.mockResolvedValue(null);
      const result = await listComments({ id: 123 });
      expect(result.content[0].text).toContain('Found 0 comments (0 total)');
      expect(mockClient.tasks.request).toHaveBeenCalledTimes(1);
    });

    function mockCommentPages(count: number, serverPageSize = 50) {
      const comments = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        task_id: 123,
        comment: `Comment text ${index + 1}`,
      }));
      mockClient.tasks.request.mockImplementation(async (
        _endpoint: unknown, _method: unknown, _body: unknown, options: unknown,
      ) => {
        const { page } = (options as { params: { page: number } }).params;
        return comments.slice((page - 1) * serverPageSize, page * serverPageSize);
      });
    }

    it.each([51, 100, 121])('returns all %i comments by default, including the newest', async (count) => {
      mockCommentPages(count);
      const result = await listComments({ id: 123 });
      const markdown = result.content[0].text;
      expect(markdown).toContain(`Found ${count} comments (${count} total)`);
      expect(markdown).toContain(`**count:** ${count}`);
      expect(markdown).toContain(`**total:** ${count}`);
      for (let id = 1; id <= count; id++) {
        expect(markdown).toContain(`Comment (ID: ${id})`);
      }
      expect(markdown.indexOf('Comment (ID: 1)')).toBeLessThan(
        markdown.indexOf(`Comment (ID: ${count})`),
      );
      expect(mockClient.tasks.request).toHaveBeenCalledTimes(Math.ceil(count / 50) + 1);
      expect(mockClient.tasks.getTaskComments).not.toHaveBeenCalled();
    });

    it('continues when the server caps the requested page size', async () => {
      mockCommentPages(55, 20);
      const result = await listComments({ id: 123 });
      expect(result.content[0].text).toContain('Found 55 comments (55 total)');
      expect(result.content[0].text).toContain('Comment (ID: 55)');
      expect(mockClient.tasks.request).toHaveBeenCalledTimes(4);
    });

    it('returns a requested page with the full total', async () => {
      mockCommentPages(121);
      const result = await listComments({ id: 123, page: 2 });
      const markdown = result.content[0].text;
      expect(markdown).toContain('Found 50 comments (121 total)');
      expect(markdown).toContain('**count:** 50');
      expect(markdown).toContain('**total:** 121');
      expect(markdown).toContain('Comment (ID: 51)');
      expect(markdown).toContain('Comment (ID: 100)');
      expect(markdown).not.toContain('Comment (ID: 50)');
      expect(markdown).not.toContain('Comment (ID: 101)');
    });

    it('reverses the full list before selecting a newest-first page', async () => {
      mockCommentPages(121);
      const result = await listComments({ id: 123, page: 1, perPage: 2, newestFirst: true });
      const markdown = result.content[0].text;
      expect(markdown).toContain('Found 2 comments (121 total)');
      expect(markdown.indexOf('Comment (ID: 121)')).toBeGreaterThan(-1);
      expect(markdown.indexOf('Comment (ID: 121)')).toBeLessThan(markdown.indexOf('Comment (ID: 120)'));
      expect(markdown).not.toContain('Comment (ID: 119)');
      expect(markdown).not.toContain('Comment (ID: 1)');
    });

    it('returns all comments newest first when page is omitted, even with perPage', async () => {
      mockCommentPages(51);
      const result = await listComments({ id: 123, perPage: 2, newestFirst: true });
      const markdown = result.content[0].text;
      expect(markdown).toContain('Found 51 comments (51 total)');
      expect(markdown.indexOf('Comment (ID: 51)')).toBeLessThan(markdown.indexOf('Comment (ID: 1)'));
    });

    it('returns an empty out-of-range page without losing the total', async () => {
      mockCommentPages(51);
      const result = await listComments({ id: 123, page: 3 });
      expect(result.content[0].text).toContain('Found 0 comments (51 total)');
      expect(result.content[0].text).toContain('**total:** 51');
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid pagination value %s before fetching', async (value) => {
      await expect(listComments({ id: 123, page: value })).rejects.toThrow('page must be a positive safe integer');
      await expect(listComments({ id: 123, perPage: value })).rejects.toThrow('perPage must be a positive safe integer');
      expect(mockClient.tasks.request).not.toHaveBeenCalled();
    });

    it('fails rather than returning a silently incomplete list when a later page fails', async () => {
      mockClient.tasks.request
        .mockResolvedValueOnce([{ id: 1, task_id: 123, comment: 'First' }])
        .mockRejectedValueOnce(new Error('Page two failed'));
      await expect(listComments({ id: 123 })).rejects.toThrow('Failed to list comments: Page two failed');
    });
  });
});
