import { describe, expect, it, vi } from 'vitest';
import { ScheduleDaemon } from './daemon';
import type { Schedule } from '@/types';
import type { CrewRun, CrewStudioWorkspace, CrewStudioCrew } from '@/types';

/**
 * Daemon-level tests. We bypass the real DB and crewRunner by injecting
 * fake deps so the suite stays hermetic — no SQLite, no subprocess, no
 * setInterval. The dep injection point is intentional (see
 * ScheduleDaemon's constructor) and is the seam any future
 * orchestrator (e.g. Snowflake Tasks) would also use.
 */

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    ownerId: 'user-a',
    workspaceId: 'ws-1',
    crewId: 'crew-1',
    name: 'Daily',
    cronExpr: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    nextFireAt: 1_000,
    lastFiredAt: null,
    lastRunId: null,
    running: true, // claim() flips this before returning
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeWorkspace(
  overrides: Partial<CrewStudioWorkspace> = {}
): CrewStudioWorkspace {
  const crew: CrewStudioCrew = {
    id: 'crew-1',
    name: 'Crew',
    description: '',
    process: 'sequential',
    agentIds: [],
    taskIds: [],
    managerAgentId: null,
    memory: false,
    planning: false,
    verbose: false,
    tags: [],
  };
  return {
    id: 'ws-1',
    ownerId: 'user-a',
    repoPath: null,
    name: 'WS',
    description: '',
    productBrief: '',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    agents: [],
    tasks: [],
    actions: [],
    crews: [crew],
    connections: [],
    subCrewInvocations: [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

function makeRun(id: string = 'run-1'): CrewRun {
  return {
    id,
    workspaceId: 'ws-1',
    ownerId: 'user-a',
    crewId: 'crew-1',
    crewName: 'Crew',
    status: 'queued',
    startedAt: 'now',
    completedAt: null,
    exitCode: null,
    inputs: {},
    output: '',
    error: null,
    events: [],
  };
}

describe('ScheduleDaemon.tick', () => {
  it('fires one run per claimed schedule and marks fired with the new next_fire_at', async () => {
    const claimed = [makeSchedule({ id: 's1' }), makeSchedule({ id: 's2' })];
    const markFired = vi.fn();
    const markFailed = vi.fn();
    // Tighten the parameter list so the mock.calls tuple keeps the
    // 5th-arg shape — vi.fn(async () => …) erases to () and the
    // subsequent calls[0][4] index can't typecheck.
    type StartRunArgs = [
      CrewStudioWorkspace,
      CrewStudioCrew,
      Record<string, string>,
      string,
      { triggerKind?: 'manual' | 'scheduled'; scheduleId?: string }?,
    ];
    const startRun = vi.fn<(...args: StartRunArgs) => Promise<CrewRun>>(
      async () => makeRun('run-x')
    );
    const daemon = new ScheduleDaemon({
      claim: () => claimed,
      markFired,
      markFailed,
      getWorkspace: () => makeWorkspace(),
      startRun,
      nextFire: () => new Date(2_000_000),
      now: () => 1_000_000,
    });
    const processed = await daemon.tick();
    expect(processed).toBe(2);
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(markFired).toHaveBeenCalledTimes(2);
    expect(markFailed).not.toHaveBeenCalled();
    // Verify the trigger metadata is forwarded into startRun's 5th arg.
    expect(startRun.mock.calls[0][4]).toEqual({
      triggerKind: 'scheduled',
      scheduleId: 's1',
    });
    // The new next_fire_at should be the .getTime() of nextFire's return.
    expect(markFired.mock.calls[0][2]).toBe(2_000_000);
  });

  it('marks failed without setting last_run_id when startRun throws', async () => {
    const markFired = vi.fn();
    const markFailed = vi.fn();
    const startRun = vi.fn(async () => {
      throw new Error('subprocess refused');
    });
    const daemon = new ScheduleDaemon({
      claim: () => [makeSchedule()],
      markFired,
      markFailed,
      getWorkspace: () => makeWorkspace(),
      startRun,
      nextFire: () => new Date(5_000),
      now: () => 1_000,
    });
    const processed = await daemon.tick();
    expect(processed).toBe(1);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]).toEqual(['s1', 5_000]);
    expect(markFired).not.toHaveBeenCalled();
  });

  it('rejects an owner-mismatched workspace (treats as missing)', async () => {
    const markFired = vi.fn();
    const markFailed = vi.fn();
    const startRun = vi.fn();
    const daemon = new ScheduleDaemon({
      claim: () => [makeSchedule({ ownerId: 'user-a' })],
      markFired,
      markFailed,
      // getWorkspace is owner-scoped and returns null when ownerId mismatches.
      getWorkspace: () => null,
      startRun,
      nextFire: () => new Date(5_000),
      now: () => 1_000,
    });
    const processed = await daemon.tick();
    expect(processed).toBe(1);
    expect(markFailed).toHaveBeenCalledOnce();
    expect(startRun).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it('marks failed when the crew has been deleted from the workspace', async () => {
    const markFired = vi.fn();
    const markFailed = vi.fn();
    const daemon = new ScheduleDaemon({
      claim: () => [makeSchedule({ crewId: 'gone' })],
      markFired,
      markFailed,
      // Workspace exists but the crew was deleted.
      getWorkspace: () => makeWorkspace({ crews: [] }),
      startRun: vi.fn(async () => makeRun()),
      nextFire: () => new Date(5_000),
      now: () => 1_000,
    });
    await daemon.tick();
    expect(markFailed).toHaveBeenCalledOnce();
    expect(markFired).not.toHaveBeenCalled();
  });

  it('returns 0 when nothing is due (no work performed)', async () => {
    const markFired = vi.fn();
    const markFailed = vi.fn();
    const startRun = vi.fn();
    const daemon = new ScheduleDaemon({
      claim: () => [],
      markFired,
      markFailed,
      getWorkspace: () => makeWorkspace(),
      startRun,
      nextFire: () => new Date(5_000),
      now: () => 1_000,
    });
    const processed = await daemon.tick();
    expect(processed).toBe(0);
    expect(startRun).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('respects the max-per-tick cap (20)', async () => {
    // Claim hands back 25 rows; the daemon must process at most 20.
    const many: Schedule[] = Array.from({ length: 25 }, (_, i) =>
      makeSchedule({ id: `s${i}` })
    );
    const startRun = vi.fn(async () => makeRun());
    const daemon = new ScheduleDaemon({
      claim: () => many,
      markFired: vi.fn(),
      markFailed: vi.fn(),
      getWorkspace: () => makeWorkspace(),
      startRun,
      nextFire: () => new Date(5_000),
      now: () => 1_000,
    });
    const processed = await daemon.tick();
    expect(processed).toBe(20);
    expect(startRun).toHaveBeenCalledTimes(20);
  });

  it('passes null next_fire_at to markFired when nextFire returns null', async () => {
    // An unparseable cron expr (or some other parse failure) means
    // nextFire returns null. The daemon should still mark the
    // schedule fired (the run did start) but with a null next_fire_at
    // so the daemon never re-claims it until the user fixes the row.
    const markFired = vi.fn();
    const daemon = new ScheduleDaemon({
      claim: () => [makeSchedule()],
      markFired,
      markFailed: vi.fn(),
      getWorkspace: () => makeWorkspace(),
      startRun: vi.fn(async () => makeRun()),
      nextFire: () => null,
      now: () => 1_000,
    });
    await daemon.tick();
    expect(markFired.mock.calls[0][2]).toBeNull();
  });
});

describe('ScheduleDaemon lifecycle', () => {
  it('start is a no-op in test environment', () => {
    // Real construction (no deps override). Because NODE_ENV === 'test'
    // in vitest, start() should bail without setting up the timer.
    const daemon = new ScheduleDaemon();
    daemon.start();
    expect(daemon.isRunning()).toBe(false);
    daemon.stop();
  });
});
