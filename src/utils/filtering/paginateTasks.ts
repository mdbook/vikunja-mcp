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
 *     `page` / `per_page`. Preserves prior behaviour. When the page might have
 *     been capped by the server we flag `possiblyTruncated` so callers know more
 *     may exist — see the lookahead logic below (the flag must key off the
 *     server's REAL cap, not the requested `per_page`, which the caller may have
 *     inflated well past the cap).
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

/** Single-page result sizes at/above this get a lookahead probe to check for
 *  truncation. This ASSUMES Vikunja's MaxItemsPerPage is 50 (its default,
 *  live-confirmed) — a page smaller than this is almost certainly the whole
 *  result (not a server-capped page) and needs no extra round-trip; a page this
 *  size or larger might be capped and is worth one cheap verification.
 *  Correctness of the flag never depends on this value — it only decides WHEN to
 *  spend the lookahead call. CAVEAT: an instance configured with a cap SMALLER
 *  than 50 would under-flag (a genuinely-capped page below 50 would skip the
 *  probe); raise nothing, but revisit this constant if MaxItemsPerPage drops. */
export const LOOKAHEAD_THRESHOLD = 50;

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
    const possiblyTruncated = await detectTruncation(fetchPage, baseParams, tasks);
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

/**
 * Decide whether a single-page result was (likely) truncated by the server.
 *
 * The naive `tasks.length >= requested per_page` check is WRONG for the case
 * that matters most: `prepareQueryParameters` inflates a missing `per_page` to
 * 1000, but Vikunja caps a page at MaxItemsPerPage (~50). So a >50 result comes
 * back as 50 while `requested` is 1000 — `50 >= 1000` is false and the
 * truncation goes unflagged (the exact bug the reviewer reproduced live).
 *
 * Instead we key off the SERVER's real cap without needing to know it:
 *   1. If the caller set a real `per_page` and the page filled it exactly, more
 *      may exist → truncated (no extra request needed).
 *   2. Otherwise, if the page is large enough to *possibly* be a server cap
 *      (>= LOOKAHEAD_THRESHOLD), do ONE cheap lookahead probe for the record
 *      immediately AFTER the returned page. A non-empty result proves there is
 *      more → truncated. This is server-cap-agnostic and does not depend on
 *      pagination headers (which node-vikunja's request() does not expose).
 *   3. A small page (< LOOKAHEAD_THRESHOLD) is almost certainly the whole result
 *      → not truncated, and we skip the extra round-trip.
 *
 * PROBE OFFSET (this is where the earlier fix was wrong): Vikunja computes
 * `offset = (page - 1) * per_page`. To read the record right after a returned
 * page of length L (which occupies offsets 0..L-1 of a default page-1 sweep) we
 * need `offset == L`. With `per_page: 1` that means `page = L + 1`
 * (offset = (L+1-1)*1 = L). A probe of `{ page: 2, per_page: 1 }` would instead
 * hit offset 1 — the SECOND record, INSIDE the page we already returned — and
 * would false-positive on every complete >=50 result (including exactly-50).
 */
async function detectTruncation(
  fetchPage: (params: GetTasksParams) => Promise<Task[] | undefined>,
  baseParams: GetTasksParams,
  tasks: Task[],
): Promise<boolean> {
  if (tasks.length === 0) {
    return false;
  }

  // Case 1: the caller's own page size was filled exactly.
  const requested = baseParams.per_page;
  if (typeof requested === 'number' && requested > 0 && tasks.length >= requested) {
    return true;
  }

  // Case 3: too small to be a server-capped page — no lookahead needed.
  if (tasks.length < LOOKAHEAD_THRESHOLD) {
    return false;
  }

  // Case 2: possibly capped — probe the record right AFTER the returned page.
  // per_page:1 with page = tasks.length + 1 → Vikunja offset = tasks.length,
  // i.e. the first record beyond what we returned (see PROBE OFFSET above).
  // Keep baseParams so the probe carries the same filter/search/sort.
  const probePage = tasks.length + 1;
  try {
    const lookahead = (await fetchPage({ ...baseParams, page: probePage, per_page: 1 })) ?? [];
    return lookahead.length > 0;
  } catch (error) {
    // A failed lookahead must not fail the list; assume possibly-truncated so
    // the result stays loudly non-silent rather than falsely "complete".
    logger.debug('Truncation lookahead failed; flagging possiblyTruncated defensively', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
