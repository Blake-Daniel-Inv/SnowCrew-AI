// Pure diff helpers for assistant proposals: compare two workspaces and
// produce a human-readable change list.
import type { CrewStudioWorkspace } from '@/types';

function entityTitle(kind: string, value: { name?: string; role?: string }): string {
  return value.name || value.role || kind;
}

export function diffEntities<T extends { id: string; name?: string; role?: string }>(
  label: string,
  before: T[],
  after: T[]
): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));

  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) {
      lines.push(`Added ${label} "${entityTitle(label, item)}"`);
    } else if (JSON.stringify(previous) !== JSON.stringify(item)) {
      lines.push(`Updated ${label} "${entityTitle(label, item)}"`);
    }
  }

  for (const item of before) {
    if (!afterById.has(item.id)) {
      lines.push(`Removed ${label} "${entityTitle(label, item)}"`);
    }
  }

  return lines;
}

export function workspaceDiff(before: CrewStudioWorkspace, after: CrewStudioWorkspace): string[] {
  const lines = [
    ...diffEntities('agent', before.agents, after.agents),
    ...diffEntities('task', before.tasks, after.tasks),
    ...diffEntities('action', before.actions, after.actions),
    ...diffEntities('crew', before.crews, after.crews),
    ...diffEntities('connection', before.connections, after.connections),
  ];

  if (before.defaultLlm !== after.defaultLlm) {
    lines.push(`Updated default LLM to ${after.defaultLlm}`);
  }
  return lines.length > 0 ? lines : ['No structural changes detected'];
}
