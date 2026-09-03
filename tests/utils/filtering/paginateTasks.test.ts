import { describe, it, expect, jest } from '@jest/globals';
import type { Task, GetTasksParams } from 'node-vikunja';
import { fetchTaskPages, MAX_AUTO_PAGES } from '../../../src/utils/filtering/paginateTasks';

jest.mock('../../../src/utils/logger');

/** Build N minimal Task stubs with sequential ids (offset-aware). */
function makeTasks(count: number, offset = 0): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: offset + i + 1,
    title: `Task ${offset + i + 1}`,
  })) as unknown as Task[];
}

describe('fetchTaskPages', () => {
  describe('single-page (default) contract', () => {
    it('fetches exactly one page and honors the caller params', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValue(makeTasks(10));

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 25 }, false);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(fetchPage).toHaveBeenCalledWith({ page: 1, per_page: 25 });
      expect(result.paginationMode).toBe('single-page');
      expect(result.pagesFetched).toBe(1);
      expect(result.tasks).toHaveLength(10);
      // 10 < 25 → not a full page → not flagged as truncated
      expect(result.possiblyTruncated).toBeUndefined();
    });

    it('flags possiblyTruncated when the page comes back completely full', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValue(makeTasks(50));

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 50 }, false);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.possiblyTruncated).toBe(true);
    });

    it('tolerates an undefined page result', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[] | undefined>>()
        .mockResolvedValue(undefined);

      const result = await fetchTaskPages(fetchPage, { per_page: 50 }, false);

      expect(result.tasks).toEqual([]);
      expect(result.possiblyTruncated).toBeUndefined();
    });
  });

  describe('server-cap truncation detection (lookahead)', () => {
    // The bug the reviewer reproduced: prepareQueryParameters inflates a missing
    // per_page to 1000, but the server caps a page at ~50. `50 >= 1000` is false,
    // so the naive check misses the truncation. The lookahead keys off the
    // server's REAL cap instead.
    it('flags possiblyTruncated via lookahead when an inflated per_page hides a server cap', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        // page 1: server caps the inflated per_page:1000 down to 50
        .mockResolvedValueOnce(makeTasks(50, 0))
        // page+1 lookahead (per_page:1): a real next item exists → more to fetch
        .mockResolvedValueOnce(makeTasks(1, 50));

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 1000 }, false);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      // The lookahead is a minimal next-page probe.
      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 2, per_page: 1 });
      expect(result.paginationMode).toBe('single-page');
      expect(result.pagesFetched).toBe(1); // pagesFetched counts the data page, not the probe
      expect(result.tasks).toHaveLength(50);
      expect(result.possiblyTruncated).toBe(true);
    });

    it('does NOT flag when a cap-sized page is actually the whole result (lookahead empty)', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(50, 0))
        .mockResolvedValueOnce([]); // no next item → exactly 50 total

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 1000 }, false);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(result.possiblyTruncated).toBeUndefined();
    });

    it('covers an explicit perPage larger than the server cap', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(50, 0)) // asked 200, server capped to 50
        .mockResolvedValueOnce(makeTasks(1, 50));

      const result = await fetchTaskPages(fetchPage, { per_page: 200 }, false);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(result.possiblyTruncated).toBe(true);
    });

    it('skips the lookahead for a small page below the cap threshold', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValue(makeTasks(30, 0));

      const result = await fetchTaskPages(fetchPage, { per_page: 1000 }, false);

      // 30 < 50 → almost certainly the whole result → no extra round-trip
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.possiblyTruncated).toBeUndefined();
    });

    it('defensively flags when the lookahead probe throws', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(50, 0))
        .mockRejectedValueOnce(new Error('probe failed'));

      const result = await fetchTaskPages(fetchPage, { per_page: 1000 }, false);

      // A failed probe must keep the result loudly non-silent, not falsely complete.
      expect(result.possiblyTruncated).toBe(true);
    });
  });

  describe('auto-paginate contract', () => {
    it('loops pages until a short page and returns ALL tasks (>50)', async () => {
      // Server caps each page at 50; total of 120 across three pages.
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(50, 0))
        .mockResolvedValueOnce(makeTasks(50, 50))
        .mockResolvedValueOnce(makeTasks(20, 100));

      const result = await fetchTaskPages(fetchPage, {}, true);

      expect(fetchPage).toHaveBeenCalledTimes(3);
      expect(result.paginationMode).toBe('auto');
      expect(result.pagesFetched).toBe(3);
      expect(result.tasks).toHaveLength(120);
      // Pages requested sequentially starting at 1
      expect(fetchPage.mock.calls[0][0]).toMatchObject({ page: 1 });
      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 2 });
      expect(fetchPage.mock.calls[2][0]).toMatchObject({ page: 3 });
    });

    it('stops on an empty trailing page (exact multiple of the cap)', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(50, 0))
        .mockResolvedValueOnce(makeTasks(50, 50))
        .mockResolvedValueOnce([]);

      const result = await fetchTaskPages(fetchPage, {}, true);

      expect(fetchPage).toHaveBeenCalledTimes(3);
      expect(result.tasks).toHaveLength(100);
    });

    it('returns a single page worth when the first page is already short', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValueOnce(makeTasks(12, 0))
        .mockResolvedValueOnce([]);

      const result = await fetchTaskPages(fetchPage, {}, true);

      // First page (12) sets the effective size; a following empty page ends it.
      expect(result.tasks).toHaveLength(12);
      expect(result.pagesFetched).toBe(2);
    });

    it('handles zero results without looping', async () => {
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValue([]);

      const result = await fetchTaskPages(fetchPage, {}, true);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.tasks).toEqual([]);
      expect(result.paginationMode).toBe('auto');
    });

    it('never exceeds the page-count safety cap on a runaway server', async () => {
      // A server that always returns a full, same-size page would loop forever
      // without the cap.
      const fetchPage = jest.fn<(p: GetTasksParams) => Promise<Task[]>>()
        .mockResolvedValue(makeTasks(50));

      const result = await fetchTaskPages(fetchPage, {}, true);

      expect(fetchPage).toHaveBeenCalledTimes(MAX_AUTO_PAGES);
      expect(result.pagesFetched).toBe(MAX_AUTO_PAGES);
    });
  });
});
