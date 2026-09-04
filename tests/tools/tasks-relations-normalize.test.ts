import { describe, it, expect } from '@jest/globals';
import {
  normalizeRelatedTasks,
  formatRelationGroups,
} from '../../src/tools/tasks-relations';

describe('normalizeRelatedTasks', () => {
  it('handles the live MAP shape (kind -> Task[]) and counts across all kinds', () => {
    const related = {
      subtask: [
        { id: 2, title: 'Child A' },
        { id: 3, title: 'Child B' },
      ],
      blocking: [{ id: 9, title: 'Blocker' }],
    };

    const { groups, total } = normalizeRelatedTasks(related);

    expect(total).toBe(3);
    const kinds = groups.map((g) => g.kind).sort();
    expect(kinds).toEqual(['blocking', 'subtask']);
    const subtask = groups.find((g) => g.kind === 'subtask')!;
    expect(subtask.tasks).toEqual([
      { id: 2, title: 'Child A' },
      { id: 3, title: 'Child B' },
    ]);
    expect(groups.find((g) => g.kind === 'blocking')!.tasks).toEqual([
      { id: 9, title: 'Blocker' },
    ]);
  });

  it('handles the flat-ARRAY shape ([{ task_id, relation_kind }]) grouped by kind', () => {
    const related = [
      { task_id: 2, relation_kind: 'subtask' },
      { task_id: 3, relation_kind: 'subtask' },
      { task_id: 9, relation_kind: 'blocking' },
    ];

    const { groups, total } = normalizeRelatedTasks(related);

    expect(total).toBe(3);
    const subtask = groups.find((g) => g.kind === 'subtask')!;
    expect(subtask.tasks).toEqual([{ id: 2 }, { id: 3 }]);
    // Array shape carries no titles
    expect(subtask.tasks.every((t) => t.title === undefined)).toBe(true);
  });

  it('returns zero for undefined / null / empty', () => {
    expect(normalizeRelatedTasks(undefined)).toEqual({ groups: [], total: 0 });
    expect(normalizeRelatedTasks(null)).toEqual({ groups: [], total: 0 });
    expect(normalizeRelatedTasks([])).toEqual({ groups: [], total: 0 });
    expect(normalizeRelatedTasks({})).toEqual({ groups: [], total: 0 });
  });

  it('skips empty kind buckets in the map shape', () => {
    const related = { subtask: [{ id: 2, title: 'A' }], blocking: [] };
    const { groups, total } = normalizeRelatedTasks(related);
    expect(total).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('subtask');
  });

  it('ignores malformed entries defensively', () => {
    const related = {
      subtask: [{ title: 'no id' }, null, { id: 5, title: 'ok' }],
    };
    const { groups, total } = normalizeRelatedTasks(related);
    expect(total).toBe(1);
    expect(groups[0].tasks).toEqual([{ id: 5, title: 'ok' }]);
  });
});

describe('formatRelationGroups', () => {
  it('renders grouped, readable markdown with id + title', () => {
    const md = formatRelationGroups([
      { kind: 'subtask', tasks: [{ id: 2, title: 'Child A' }] },
      { kind: 'blocking', tasks: [{ id: 9 }] },
    ]);
    expect(md).toContain('**subtask** (1)');
    expect(md).toContain('#2 Child A');
    expect(md).toContain('**blocking** (1)');
    expect(md).toContain('#9');
  });

  it('renders a placeholder when there are no groups', () => {
    expect(formatRelationGroups([])).toBe('_No relations._');
  });
});
