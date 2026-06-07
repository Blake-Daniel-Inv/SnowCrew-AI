// Stream A surface: shape / well-formedness checks for the embedded
// Python tool source. We don't try to exercise the GitHub API here —
// the urllib path is tested implicitly when the runner spawns a real
// crew. What we DO want to catch is:
//   - the filename helper is stable (the runner / bundler depend on it),
//   - the Python source compiles (a syntax error here would only surface
//     when a crew actually tries to import it, mid-run, which is too
//     late),
//   - the source declares the documented public surface (GitHubTool
//     class, the five method names),
//   - the source never inlines a GitHub token literal by accident
//     (defensive — the template should read GITHUB_TOKEN at runtime).
//
// The python compile step shells out to `python3 -c "compile(...)"`. If
// python3 is not on PATH (CI image without python) we skip that single
// assertion rather than failing the whole suite — the other checks still
// run and the runner's integration tests catch the rest.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_TOOL_PY,
  getGitHubToolFilename,
} from './github-tool.py';

function tryPythonCompile(source: string): { ok: boolean; reason?: string } {
  // Probe for python3 first — vitest will mark the test as passed (with
  // a console hint) when it's missing rather than failing the build.
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return { ok: false, reason: 'python3 not available on PATH' };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'github-tool-compile-'));
  try {
    const file = path.join(dir, 'github_tool.py');
    writeFileSync(file, source);
    const result = spawnSync(
      'python3',
      ['-c', `compile(open(${JSON.stringify(file)}).read(), 'github_tool.py', 'exec')`],
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

describe('getGitHubToolFilename', () => {
  it('returns the canonical github_tool.py filename', () => {
    expect(getGitHubToolFilename()).toBe('github_tool.py');
  });
});

describe('GITHUB_TOOL_PY', () => {
  it('is a non-empty Python source string', () => {
    expect(typeof GITHUB_TOOL_PY).toBe('string');
    expect(GITHUB_TOOL_PY.length).toBeGreaterThan(500);
  });

  it('declares the GitHubTool BaseTool subclass', () => {
    expect(GITHUB_TOOL_PY).toMatch(/class GitHubTool\(BaseTool\)/);
    expect(GITHUB_TOOL_PY).toMatch(/name: str = "github"/);
  });

  it('declares all five documented methods', () => {
    for (const method of [
      'list_repos',
      'get_file_contents',
      'get_pull_request',
      'get_pr_diff',
      'list_issues',
    ]) {
      expect(GITHUB_TOOL_PY, `method ${method} missing`).toMatch(
        new RegExp(`\\b${method}\\b`)
      );
    }
  });

  it('reads GITHUB_TOKEN from os.environ at call time', () => {
    // The contract is: token comes from env at call time so a token set
    // after module load is still picked up. If someone refactors this
    // into a module-level constant they'll break that contract — guard.
    expect(GITHUB_TOOL_PY).toMatch(/os\.environ\.get\("GITHUB_TOKEN"/);
  });

  it('sends the documented HTTP headers', () => {
    expect(GITHUB_TOOL_PY).toMatch(/User-Agent.*SnowCrewAI|SnowCrewAI/);
    expect(GITHUB_TOOL_PY).toMatch(/application\/vnd\.github\+json/);
    expect(GITHUB_TOOL_PY).toMatch(/X-GitHub-Api-Version/);
    expect(GITHUB_TOOL_PY).toMatch(/2022-11-28/);
  });

  it('caps diff responses at 256 KB', () => {
    expect(GITHUB_TOOL_PY).toMatch(/256 \* 1024/);
    expect(GITHUB_TOOL_PY).toMatch(/truncated/);
  });

  it('surfaces a clear error on 401/403', () => {
    expect(GITHUB_TOOL_PY).toMatch(
      /token may be revoked or lacks required scope/
    );
  });

  it('returns a credential-missing message when GITHUB_TOKEN is unset', () => {
    expect(GITHUB_TOOL_PY).toMatch(
      /GitHub credential not configured for this user/
    );
    expect(GITHUB_TOOL_PY).toMatch(/Connect at \/settings/);
  });

  it('filters PRs out of list_issues results', () => {
    expect(GITHUB_TOOL_PY).toMatch(/"pull_request" not in item/);
  });

  it('never embeds a literal GitHub token in the source', () => {
    // Defensive: a hardcoded "ghp_..." / "github_pat_..." here would
    // ship that token to every generated crew bundle. Any commit that
    // introduces one fails this guard.
    expect(GITHUB_TOOL_PY).not.toMatch(/ghp_[A-Za-z0-9]{36,}/);
    expect(GITHUB_TOOL_PY).not.toMatch(/github_pat_[A-Za-z0-9_]{82,}/);
  });

  it('compiles as valid Python (skipped if python3 unavailable)', () => {
    const result = tryPythonCompile(GITHUB_TOOL_PY);
    if (!result.ok && result.reason === 'python3 not available on PATH') {
      // Soft-skip — surface the reason so CI logs explain the skip but
      // do not fail. (We could vitest.skip here, but the suite-level
      // describe.skipIf would suppress the documenting message.)
      console.warn(`[github-tool.test] ${result.reason}; compile check skipped`);
      return;
    }
    expect(result.ok, result.reason).toBe(true);
  });
});
