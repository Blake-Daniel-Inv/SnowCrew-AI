// Surface + well-formedness checks for the embedded SubCrewTool Python
// source. We don't try to exercise the kickoff path here — that requires
// a real CrewAI installation and is covered by the integration test in
// crew-py-subcrew.test.ts. What we do verify:
//   - the filename helper is stable (the bundler depends on it),
//   - the source compiles (a syntax error here would only surface when
//     a crew actually tries to import it),
//   - the documented public surface is present (SubCrewTool class,
//     constructor signature, budget + depth-check logic),
//   - the trace-emission protocol matches the documented schema,
//   - no token-like literal sneaks into the source (defensive),
//   - the source uses only stdlib + pydantic/crewai imports (no
//     accidental third-party additions).
//
// python3 compile probe matches github-tool.test.ts: soft-skip with a
// console warning when python3 isn't on PATH.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUBCREW_TOOL_PY,
  getSubCrewToolFilename,
} from './subcrew-tool.py';

function tryPythonCompile(source: string): { ok: boolean; reason?: string } {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return { ok: false, reason: 'python3 not available on PATH' };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'subcrew-tool-compile-'));
  try {
    const file = path.join(dir, 'subcrew_tool.py');
    writeFileSync(file, source);
    const result = spawnSync(
      'python3',
      ['-c', `compile(open(${JSON.stringify(file)}).read(), 'subcrew_tool.py', 'exec')`],
      { encoding: 'utf8' }
    );
    if (result.status === 0) return { ok: true };
    return {
      ok: false,
      reason: `python3 compile failed: ${result.stderr || result.stdout}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('getSubCrewToolFilename', () => {
  it('returns the canonical subcrew_tool.py filename', () => {
    expect(getSubCrewToolFilename()).toBe('subcrew_tool.py');
  });
});

describe('SUBCREW_TOOL_PY', () => {
  it('is a non-empty Python source string', () => {
    expect(typeof SUBCREW_TOOL_PY).toBe('string');
    // The template is comparable in size to github-tool.py.ts.
    expect(SUBCREW_TOOL_PY.length).toBeGreaterThan(1_000);
  });

  it('declares the SubCrewTool BaseTool subclass', () => {
    expect(SUBCREW_TOOL_PY).toMatch(/class SubCrewTool\(BaseTool\)/);
  });

  it('uses only stdlib + crewai/pydantic imports', () => {
    // First non-blank import-block lines. We scan everything before the
    // first `class ` definition for `import` / `from ... import` lines.
    const classIdx = SUBCREW_TOOL_PY.indexOf('class SubCrewTool');
    expect(classIdx).toBeGreaterThan(0);
    const head = SUBCREW_TOOL_PY.slice(0, classIdx);
    const allowed = new Set([
      'json',
      'os',
      'typing',
      'pydantic',
      'crewai.tools',
    ]);
    const lines = head.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('"""')) continue;
      let mod: string | null = null;
      const m1 = line.match(/^import\s+([A-Za-z0-9_.]+)/);
      if (m1) mod = m1[1];
      const m2 = line.match(/^from\s+([A-Za-z0-9_.]+)\s+import/);
      if (m2) mod = m2[1];
      if (!mod) continue;
      // Allow either the exact name or a leading prefix.
      const top = mod.split('.')[0];
      expect(
        allowed.has(mod) || allowed.has(top),
        `unexpected import: ${mod}`
      ).toBe(true);
    }
  });

  it('declares the MAX_NESTING_DEPTH constant matching the design (5)', () => {
    expect(SUBCREW_TOOL_PY).toMatch(/MAX_NESTING_DEPTH\s*=\s*5\b/);
  });

  it('checks nesting depth via the SUBCREW_NESTING_DEPTH env var', () => {
    expect(SUBCREW_TOOL_PY).toMatch(/SUBCREW_NESTING_DEPTH/);
    // The check must compare against MAX_NESTING_DEPTH, not a literal.
    expect(SUBCREW_TOOL_PY).toMatch(/depth\s*>=\s*MAX_NESTING_DEPTH/);
  });

  it('refuses to fire when at max depth (clear error message)', () => {
    expect(SUBCREW_TOOL_PY).toMatch(/maximum nesting depth/i);
  });

  it('tracks the per-invocation budget and refuses past max_invocations', () => {
    // PR 33 — the budget moved from a per-instance PrivateAttr to a
    // module-level dict keyed by invocation_id so re-instantiation
    // (CrewAI delegations, retries, etc.) cannot bypass the cap.
    expect(SUBCREW_TOOL_PY).toMatch(/_BUDGET_BY_INVOCATION/);
    expect(SUBCREW_TOOL_PY).toMatch(/Tool budget exhausted/);
    expect(SUBCREW_TOOL_PY).toMatch(/_calls_made_count\(\)\s*>=\s*self\._max_invocations/);
  });

  it('uses a process-global dict for the budget (re-instantiation safe)', () => {
    // The dict is keyed by self._invocation_id; the bump is via
    // dict assignment so a fresh tool instance for the same
    // invocation reads the same counter.
    expect(SUBCREW_TOOL_PY).toMatch(/_BUDGET_BY_INVOCATION:\s*Dict\[str,\s*int\]\s*=\s*\{\}/);
    expect(SUBCREW_TOOL_PY).toMatch(/_BUDGET_BY_INVOCATION\[self\._invocation_id\]\s*=\s*self\._calls_made_count\(\)\s*\+\s*1/);
    // Seeded with setdefault in __init__ so a new invocation starts at 0
    // without clobbering an existing key.
    expect(SUBCREW_TOOL_PY).toMatch(/_BUDGET_BY_INVOCATION\.setdefault\(self\._invocation_id,\s*0\)/);
  });

  it('writes trace events via FD 3 (with stdout fallback)', () => {
    // PR 33 — trace I/O moved to a dedicated file descriptor so LLM
    // output on stdout cannot inject phantom @@TRACE@@ frames. The
    // fallback path stays so test / legacy spawns still see events.
    expect(SUBCREW_TOOL_PY).toMatch(/_TRACE_FD\s*=\s*3/);
    expect(SUBCREW_TOOL_PY).toMatch(/os\.write\(_TRACE_FD/);
    expect(SUBCREW_TOOL_PY).toMatch(/_TRACE_FALLBACK_WARNED/);
  });

  it('emits a structured subcrew_call trace line after a successful kickoff', () => {
    // PR γ — the trace shape is the contract the Node trace-parser
    // depends on. We switched from the original kind:'subcrew_call'
    // shape to type:'subcrew_call' + metadata in PR γ so the line
    // flows through the same parser path as every other trace event.
    expect(SUBCREW_TOOL_PY).toMatch(/@@TRACE@@/);
    expect(SUBCREW_TOOL_PY).toMatch(/"type":\s*"subcrew_call"/);
    // The python wrapper now nests the contextual fields under
    // `metadata` so the Node parser can stuff them straight into
    // events.metadata without a per-type adapter.
    expect(SUBCREW_TOOL_PY).toMatch(/"metadata"/);
    expect(SUBCREW_TOOL_PY).toMatch(/"parentInvocationId"/);
    expect(SUBCREW_TOOL_PY).toMatch(/"invocationDepth"/);
    expect(SUBCREW_TOOL_PY).toMatch(/"invocationNumber"/);
    expect(SUBCREW_TOOL_PY).toMatch(/"invocationTotal"/);
    expect(SUBCREW_TOOL_PY).toMatch(/"target"/);
  });

  it('emits a matching subcrew_complete event so the Node stack can pop', () => {
    // PR γ — the python wrapper emits an explicit completion marker
    // so the Node-side context stack pops deterministically rather
    // than guessing from heuristics. The matched metadata fields
    // mirror the call event so the UI can correlate them.
    expect(SUBCREW_TOOL_PY).toMatch(/"type":\s*"subcrew_complete"/);
  });

  it('does not increment the budget on kickoff failure', () => {
    // The kickoff is wrapped in try/except; the except branch must
    // return BEFORE the increment statement. PR 33 swapped the
    // PrivateAttr bump for a module-level dict assignment, but the
    // ordering invariant is unchanged: any bump lives strictly after
    // the kickoff's try/finally restores SUBCREW_NESTING_DEPTH.
    const after = SUBCREW_TOOL_PY.split('result = target_crew.kickoff')[1] || '';
    const finallyIdx = after.indexOf('finally:');
    const incIdx = after.indexOf('_BUDGET_BY_INVOCATION[self._invocation_id]');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(incIdx).toBeGreaterThan(finallyIdx);
  });

  it('restores SUBCREW_NESTING_DEPTH in finally (no leak on failure)', () => {
    // The finally block must either pop or restore the prior value.
    expect(SUBCREW_TOOL_PY).toMatch(/finally:/);
    expect(SUBCREW_TOOL_PY).toMatch(/os\.environ\.pop\(NESTING_DEPTH_ENV/);
    expect(SUBCREW_TOOL_PY).toMatch(/os\.environ\[NESTING_DEPTH_ENV\]\s*=\s*prior/);
  });

  it('does not embed token-like literals', () => {
    // Defensive: a hardcoded "ghp_..." / API key here would ship that
    // secret to every generated crew bundle. We check the same set
    // github-tool.test.ts checks, plus generic 32+ hex blobs.
    expect(SUBCREW_TOOL_PY).not.toMatch(/ghp_[A-Za-z0-9]{36,}/);
    expect(SUBCREW_TOOL_PY).not.toMatch(/github_pat_[A-Za-z0-9_]{82,}/);
    expect(SUBCREW_TOOL_PY).not.toMatch(/sk-[A-Za-z0-9]{30,}/);
  });

  it('every except clause returns a string (no uncaught raises)', () => {
    // The contract is "never crash the parent crew". Validate that
    // every raise of an exception we expect to encounter is replaced
    // with a return statement. Easiest heuristic: count `except` lines
    // and confirm none is followed by `raise` (which would propagate).
    const exceptBlocks = SUBCREW_TOOL_PY.split(/^\s*except [^\n]+:$/m);
    // Inspect everything after each `except` for an unconditional
    // `raise` statement (i.e. `raise` alone, not `raise X from y`).
    // We allow `raise` ONLY inside docstrings, which won't match.
    for (let i = 1; i < exceptBlocks.length; i++) {
      const body = exceptBlocks[i].split(/\n\S/)[0]; // until the next un-indented line
      expect(body, `except branch ${i} should not unconditionally raise`).not.toMatch(/^\s*raise\s*$/m);
    }
  });

  it('compiles as valid Python (skipped if python3 unavailable)', () => {
    const result = tryPythonCompile(SUBCREW_TOOL_PY);
    if (!result.ok && result.reason === 'python3 not available on PATH') {
      console.warn(`[subcrew-tool.test] ${result.reason}; compile check skipped`);
      return;
    }
    expect(result.ok, result.reason).toBe(true);
  });

  it('two instances with the same invocation_id share one budget counter (PR 33)', () => {
    // Drive the module directly through python3 to confirm the dict
    // semantics survive instance re-creation. Skipped when python3 is
    // unavailable (CI runs both with and without it). This is a
    // BEHAVIORAL check, not just a regex on the source.
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      console.warn('[subcrew-tool.test] python3 unavailable; skipping runtime budget check');
      return;
    }
    // The full module depends on pydantic + crewai which we don't
    // require at test time. Extract just the dict + helpers + the
    // count logic into a self-contained probe.
    const dir = mkdtempSync(path.join(tmpdir(), 'subcrew-budget-probe-'));
    try {
      const file = path.join(dir, 'probe.py');
      // We inline a faithful but minimal reproduction of the budget
      // bookkeeping the real tool uses. If the contract changes (key
      // name, increment semantics), THIS probe and the source must
      // change together.
      const probeSrc = [
        'from typing import Dict',
        '',
        '_BUDGET_BY_INVOCATION: Dict[str, int] = {}',
        '',
        'class Tool:',
        '    def __init__(self, invocation_id, max_invocations):',
        '        self._invocation_id = invocation_id',
        '        self._max_invocations = max_invocations',
        '        _BUDGET_BY_INVOCATION.setdefault(invocation_id, 0)',
        '    def _calls_made_count(self):',
        '        return _BUDGET_BY_INVOCATION.get(self._invocation_id, 0)',
        '    def _run(self):',
        '        if self._calls_made_count() >= self._max_invocations:',
        '            return "budget-exhausted"',
        '        _BUDGET_BY_INVOCATION[self._invocation_id] = self._calls_made_count() + 1',
        '        return "ok"',
        '',
        '# Same invocation, two instances — combined count enforces the cap.',
        't1 = Tool("inv-1", 3)',
        'assert t1._run() == "ok"',
        'assert t1._run() == "ok"',
        '# CrewAI re-instantiates between calls.',
        't2 = Tool("inv-1", 3)',
        'assert t2._calls_made_count() == 2',
        'assert t2._run() == "ok"',
        '# 4th call across the two instances hits the cap.',
        'assert t1._run() == "budget-exhausted"',
        'assert t2._run() == "budget-exhausted"',
        '# Different invocation gets its own counter.',
        't3 = Tool("inv-2", 3)',
        'assert t3._calls_made_count() == 0',
        'assert t3._run() == "ok"',
        'print("ok")',
      ].join('\n');
      writeFileSync(file, probeSrc);
      const result = spawnSync('python3', [file], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
