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

/**
 * A FAITHFUL Vikunja-like page fetcher over a fixed N-row store. It respects the
 * query's `page`/`per_page` exactly the way the server does:
 *   offset = (page - 1) * per_page   (uses the REQUESTED per_page)
 *   limit  = min(per_page, cap)      (server caps at MaxItemsPerPage)
 * returning `store.slice(offset, offset + limit)`.
 *
 * This is what a param-ignoring `mockResolvedValueOnce` stub can't do — it's the
 * only kind of fake that actually exercises the probe's offset math (a wrong
 * probe offset reads records INSIDE the returned page and false-positives).
 */
function makeOffsetRespectingFetch(total: number, cap = 50) {
  const store = makeTasks(total);
  return jest.fn((params: GetTasksParams): Promise<Task[]> => {
    const page = params.page ?? 1;
    const perPage = params.per_page ?? cap;
    const offset = (page - 1) * perPage;
    const limit = Math.min(perPage, cap);
    return Promise.resolve(store.slice(offset, offset + limit));
  });
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

  describe('server-cap truncation detection (offset-respecting lookahead)', () => {
    // The bug the reviewer reproduced twice: prepareQueryParameters inflates a
    // missing per_page to 1000, the server caps a page at ~50, and the probe
    // must read the record AFTER the returned page (offset == page length), NOT
    // offset 1 (which is inside the page). These use a faithful offset-respecting
    // fake so a wrong probe offset genuinely fails the test.

    it('EXACTLY 50 total (cap 50, per_page inflated to 1000) → possiblyTruncated FALSE', async () => {
      // The core acceptance case. Probe at offset 50 must return [] → not truncated.
      const fetchPage = makeOffsetRespectingFetch(50);

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 1000 }, false);

      expect(result.tasks).toHaveLength(50);
      expect(result.possiblyTruncated).toBeUndefined();
      // Two calls: the data page + the probe. Probe offset == returned length.
      expect(fetchPage).toHaveBeenCalledTimes(2);
      const probe = fetchPage.mock.calls[1][0];
      expect(probe).toMatchObject({ page: 51, per_page: 1 }); // page = len + 1 → offset 50
    });

    it('51 total → possiblyTruncated TRUE (probe at offset 50 finds record #51)', async () => {
      const fetchPage = makeOffsetRespectingFetch(51);

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 1000 }, false);

      expect(result.tasks).toHaveLength(50);
      expect(result.possiblyTruncated).toBe(true);
      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 51, per_page: 1 });
    });

    it('200 total → possiblyTruncated TRUE', async () => {
      const fetchPage = makeOffsetRespectingFetch(200);

      const result = await fetchTaskPages(fetchPage, { page: 1, per_page: 1000 }, false);

      expect(result.tasks).toHaveLength(50);
      expect(result.possiblyTruncated).toBe(true);
    });

    it('covers an explicit perPage larger than the server cap (200 requested, 60 total)', async () => {
      const fetchPage = makeOffsetRespectingFetch(60);

      const result = await fetchTaskPages(fetchPage, { per_page: 200 }, false);

      // Server capped to 50; probe at offset 50 finds records 51..60 → truncated.
      expect(result.tasks).toHaveLength(50);
      expect(result.possiblyTruncated).toBe(true);
      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 51, per_page: 1 });
    });

    it('30 total (< threshold) → FALSE with NO lookahead', async () => {
      const fetchPage = makeOffsetRespectingFetch(30);

      const result = await fetchTaskPages(fetchPage, { per_page: 1000 }, false);

      expect(result.tasks).toHaveLength(30);
      expect(result.possiblyTruncated).toBeUndefined();
      expect(fetchPage).toHaveBeenCalledTimes(1); // no probe
    });

    it('probe targets offset == returned length, not offset 1 (regression guard)', async () => {
      // With the OLD buggy probe ({page:2, per_page:1} → offset 1), a store of
      // exactly 50 would return record #2 and false-positive. The offset-respecting
      // fake makes that failure real: assert the exactly-50 store stays FALSE.
      const fetchPage = makeOffsetRespectingFetch(50);
      const result = await fetchTaskPages(fetchPage, { per_page: 1000 }, false);
      expect(result.possiblyTruncated).toBeUndefined();
      // The probe must NOT be page 2 (offset 1); it must be page 51 (offset 50).
      expect(fetchPage.mock.calls[1][0]).not.toMatchObject({ page: 2 });
      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 51, per_page: 1 });
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
