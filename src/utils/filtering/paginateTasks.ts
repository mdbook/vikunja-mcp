/**
 * Task pagination helper.
 *
 * Vikunja caps a single task page at its server-side `MaxItemsPerPage`
 * (default 50). Requesting `per_page: 1000` therefore silently returns only
 * the first ~50 tasks — a sweep with more matches loses the rest with no error.
 *
 * This helper centralises two contracts used by every task-listing strategy:
 *
 *   - **single-page** (default): fetch exactly one page, honouring the caller's
 *     `page` / `per_page`. Preserves prior behaviour. When the page comes back
 *     completely full we flag `possiblyTruncated` so callers know more may exist.
 *   - **auto-paginate** (opt-in via `autoPaginate`): loop pages until the server
 *     returns a short or empty page, accumulating every match. This is the
 *     escape hatch for "give me everything" sweeps that must never truncate.
 */

import type { Task, GetTasksParams } from 'node-vikunja';
import { logger } from '../logger';

/** Page size requested per round-trip when auto-paginating. Vikunja will cap
 *  this to its own MaxItemsPerPage; the real page size is detected from the
 *  first response rather than assumed. */
export const AUTO_PAGE_REQUEST_SIZE = 250;

/** Hard safety cap on how many pages a single auto-paginate sweep will fetch,
 *  so a misbehaving/looping server can never cause an unbounded fetch. */
export const MAX_AUTO_PAGES = 100;

export interface PaginationOutcome {
  tasks: Task[];
  /** Which contract was used. */
  paginationMode: 'single-page' | 'auto';
  /** Number of API pages actually fetched. */
  pagesFetched: number;
  /** single-page only: the returned page was completely full, so more tasks
   *  may exist beyond it (pass `allTasks: true` or a larger `perPage`). */
  possiblyTruncated?: boolean;
}

/**
 * Fetch task pages according to the single-page / auto-paginate contract.
 *
 * @param fetchPage - closure that fetches ONE page for the given params
 *                    (the caller wires in getAllTasks vs getProjectTasks and any
 *                    server-side filter it needs).
 * @param baseParams - base query params (page / per_page / filter / sort / s).
 * @param autoPaginate - when true, loop every page until exhausted.
 */
export async function fetchTaskPages(
  fetchPage: (params: GetTasksParams) => Promise<Task[] | undefined>,
  baseParams: GetTasksParams,
  autoPaginate: boolean,
): Promise<PaginationOutcome> {
  if (!autoPaginate) {
    const tasks = (await fetchPage(baseParams)) ?? [];
    // If the caller asked for a bounded page and we filled it exactly, more
    // tasks likely exist beyond this page — surface that so it isn't silent.
    const requested = baseParams.per_page;
    const possiblyTruncated =
      typeof requested === 'number' && requested > 0 && tasks.length >= requested;
    return {
      tasks,
      paginationMode: 'single-page',
      pagesFetched: 1,
      ...(possiblyTruncated ? { possiblyTruncated: true } : {}),
    };
  }

  // Auto-paginate: walk pages until a short/empty page signals the end.
  const all: Task[] = [];
  let page = baseParams.page ?? 1;
  let pagesFetched = 0;
  let effectivePageSize: number | undefined;

  while (pagesFetched < MAX_AUTO_PAGES) {
    const pageParams: GetTasksParams = {
      ...baseParams,
      page,
      per_page: baseParams.per_page ?? AUTO_PAGE_REQUEST_SIZE,
    };
    const batch = (await fetchPage(pageParams)) ?? [];
    pagesFetched += 1;
    all.push(...batch);

    // Empty page → nothing more to fetch.
    if (batch.length === 0) {
      break;
    }

    // The server's effective page size is whatever it returned for the first
    // page (it caps per_page at MaxItemsPerPage). A subsequent page smaller
    // than that means we've reached the final page.
    if (effectivePageSize === undefined) {
      effectivePageSize = batch.length;
    } else if (batch.length < effectivePageSize) {
      break;
    }

    page += 1;
  }

  if (pagesFetched >= MAX_AUTO_PAGES) {
    logger.warn('Auto-pagination hit the page-count safety cap; results may be truncated', {
      maxPages: MAX_AUTO_PAGES,
      tasksLoaded: all.length,
    });
  }

  return {
    tasks: all,
    paginationMode: 'auto',
    pagesFetched,
  };
}
