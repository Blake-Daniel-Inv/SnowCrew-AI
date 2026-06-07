// Stream A surface: shape / well-formedness checks for the embedded
// SPCS token-refresh daemon. The daemon's actual runtime behavior
// (sleep loop, file polling) is hard to exercise from a unit test
// without spinning a real subprocess and faking the /snowflake mount —
// the runner's integration tests catch that. What we DO assert here:
//   - the filename helper is stable (the bundler depends on it),
//   - the Python source compiles (a syntax error would only surface
//     when a crew tries to import it, mid-run, which is too late),
//   - the documented public surface is present (start_token_refresh_thread,
//     the env-var knobs, the daemon=True flag),
//   - the source never logs token bytes (defensive — a regression here
//     would leak a credential into every run's trace),
//   - the env-var knob names match what the Node-side runner forwards.
//
// The python compile step shells out to `python3 -c "compile(...)"`. If
// python3 is not on PATH (CI image without python) we soft-skip that
// single assertion rather than failing the whole suite — the other
// checks still run.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SNOWFLAKE_TOKEN_REFRESH_PY,
  getSnowflakeTokenRefreshFilename,
} from './snowflake-token-refresh.py';

function tryPythonCompile(source: string): { ok: boolean; reason?: string } {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return { ok: false, reason: 'python3 not available on PATH' };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'snowflake-token-refresh-compile-'));
  try {
    const file = path.join(dir, 'snowflake_token_refresh.py');
    writeFileSync(file, source);
    const result = spawnSync(
      'python3',
      ['-c', `compile(open(${JSON.stringify(file)}).read(), 'snowflake_token_refresh.py', 'exec')`],
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

describe('getSnowflakeTokenRefreshFilename', () => {
  it('returns the canonical snowflake_token_refresh.py filename', () => {
    expect(getSnowflakeTokenRefreshFilename()).toBe('snowflake_token_refresh.py');
  });
});

describe('SNOWFLAKE_TOKEN_REFRESH_PY', () => {
  it('is a non-empty Python source string', () => {
    expect(typeof SNOWFLAKE_TOKEN_REFRESH_PY).toBe('string');
    expect(SNOWFLAKE_TOKEN_REFRESH_PY.length).toBeGreaterThan(500);
  });

  it('exposes the public start_token_refresh_thread() entry point', () => {
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/def start_token_refresh_thread\(\)/);
  });

  it('spawns a daemon thread (so the main process can exit cleanly)', () => {
    // Critical correctness check: a non-daemon thread here would block
    // process exit when the crew is done, hanging the runner forever.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/daemon=True/);
  });

  it('reads from the canonical SPCS mount path', () => {
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/\/snowflake\/session\/token/);
  });

  it('honors the SPCS_TOKEN_REFRESH_ENABLED kill switch', () => {
    // The Node runner forwards this env var; the contract is "0 = off".
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/SPCS_TOKEN_REFRESH_ENABLED/);
  });

  it('honors the SPCS_TOKEN_REFRESH_INTERVAL_SECS override', () => {
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/SPCS_TOKEN_REFRESH_INTERVAL_SECS/);
  });

  it('mutates SNOWFLAKE_JWT in os.environ after a refresh', () => {
    // The whole point of the daemon — verify the contract is wired.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/os\.environ\[["']SNOWFLAKE_JWT["']\]\s*=/);
  });

  it('refuses to overwrite an existing pat/ prefixed value', () => {
    // PAT mode is incompatible with SPCS rotation; the daemon must not
    // clobber a PAT with a raw OAuth bearer (credential-confusion bug).
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/startswith\(["']pat\/["']\)/);
  });

  it('emits a structured @@TRACE@@ line on successful refresh', () => {
    // The runner's trace-parser fans this out into the run UI.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/@@TRACE@@ /);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/token-refresh/);
  });

  it('catches and logs all loop exceptions (thread must never die)', () => {
    // Broad except in the loop body is load-bearing: the daemon has to
    // survive a transient FS error mid-rotation. The thread cannot die.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/except Exception/);
  });

  it('uses only Python standard library imports (no new pip deps)', () => {
    // PR 11 hard constraint: no new python deps. The module must work
    // against a vanilla Python 3.10+ install.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/import threading/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/import os/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/import time/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).toMatch(/import json/);
    // Guard against a regression that pulls in third-party deps.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/^import requests/m);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/^import snowflake/m);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/^import litellm/m);
  });

  it('never embeds a literal token in the source', () => {
    // Defensive: a hardcoded bearer/JWT shape in the template would
    // ship that credential to every generated crew bundle.
    // JWTs are three base64url segments separated by dots.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/
    );
    // PAT-style prefix followed by an actual token body.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/pat\/[A-Za-z0-9_-]{40,}/);
  });

  it('never logs the token bytes', () => {
    // Forbidden patterns: any code path that would write the raw token
    // value into stdout/stderr. The structured trace only carries
    // generic strings ("refreshed SPCS session token"), never the bytes.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/print\(\s*token\s*\)/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/print\(\s*fresh\s*\)/);
    // Defend against an f-string format that would interpolate the
    // token into a log line. Token values live in `token`, `fresh`, or
    // `content` in this module.
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/f["'][^"']*\{token\}/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/f["'][^"']*\{fresh\}/);
    expect(SNOWFLAKE_TOKEN_REFRESH_PY).not.toMatch(/f["'][^"']*\{content\}/);
  });

  it('compiles as valid Python (skipped if python3 unavailable)', () => {
    const result = tryPythonCompile(SNOWFLAKE_TOKEN_REFRESH_PY);
    if (!result.ok && result.reason === 'python3 not available on PATH') {
      console.warn(
        `[snowflake-token-refresh.test] ${result.reason}; compile check skipped`
      );
      return;
    }
    expect(result.ok, result.reason).toBe(true);
  });
});
