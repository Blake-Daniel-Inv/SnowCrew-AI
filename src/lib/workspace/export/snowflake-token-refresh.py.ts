// Embedded SPCS session-token refresh daemon. Bundled into every crew
// run; the helper is a no-op outside SPCS (i.e. when
// /snowflake/session/token does not exist).
//
// Why this exists: Snowpark Container Services rotates the file at
// /snowflake/session/token roughly hourly. The Node runner reads the
// token ONCE at run start and forwards it into the Python child as
// SNOWFLAKE_JWT. Long crews (>60min) silently 401 partway through when
// the original token expires and the child never picks up the rotated
// value. This module spawns a single daemon thread inside the child
// that re-reads the file on a schedule and mutates os.environ so the
// next LiteLLM call (which reads SNOWFLAKE_JWT lazily per request) uses
// the fresh value.
//
// Local mode (PAT/JWT in env, no SPCS mount) is unaffected: the file
// doesn't exist, so start_token_refresh_thread() returns before
// spawning anything. Zero overhead outside SPCS.
//
// Token bytes NEVER appear in any log line — only generic refresh /
// failure messages are emitted via the standard @@TRACE@@ protocol.

export const SNOWFLAKE_TOKEN_REFRESH_PY = `"""SPCS session-token refresh daemon.

Long-running crews (>60min) silently 401 when SPCS rotates the mounted
session token under them. This module spawns ONE daemon thread that
re-reads /snowflake/session/token on a schedule and mutates os.environ
so subsequent LiteLLM / Cortex calls pick up the fresh value.

Public surface:
    start_token_refresh_thread()
        Idempotent. Safe to call multiple times — only the first call
        actually spawns the thread. Returns immediately (and is a true
        no-op) when /snowflake/session/token does not exist, so local
        PAT/JWT runs pay zero overhead.

Knobs (environment variables):
    SPCS_TOKEN_REFRESH_ENABLED=0
        Force-disable the refresher. Default is enabled when the token
        file exists.
    SPCS_TOKEN_REFRESH_INTERVAL_SECS=<int>
        Override the default 300s (5 min) refresh interval. Bounded to
        [30, 3600] to defend against typos like '0'.

Logging:
    Successful refreshes emit a single @@TRACE@@ JSON line of kind
    'info', source 'token-refresh'. Failures emit to stderr with no
    token bytes. The thread NEVER dies — every iteration is wrapped in
    a broad except so a transient FS error (volume unmount mid-rotate)
    doesn't kill the refresher.
"""

import datetime
import json
import os
import sys
import threading
import time

SPCS_TOKEN_PATH = "/snowflake/session/token"
DEFAULT_INTERVAL_SECS = 300  # 5 minutes
MIN_INTERVAL_SECS = 30
MAX_INTERVAL_SECS = 3600

# Module-level latch so a double-call (e.g. from a re-imported crew.py
# during a hot reload) doesn't spawn duplicate threads. The lock guards
# the latch flip so two callers racing through start_token_refresh_thread
# can't both win the gate.
_LATCH_LOCK = threading.Lock()
_THREAD_STARTED = False


def _trace(kind, msg, **extra):
    """Emit a structured @@TRACE@@ line on stdout. Matches the runner's
    trace-parser protocol — kind is one of 'info', 'warning'. NEVER pass
    a token here; this string lands in the user-visible run trace."""
    payload = {
        "kind": kind,
        "source": "token-refresh",
        "msg": msg,
        "at": datetime.datetime.utcnow().isoformat() + "Z",
    }
    payload.update(extra)
    try:
        print("@@TRACE@@ " + json.dumps(payload), flush=True)
    except Exception:
        # Best-effort logging; never let a print failure crash the daemon.
        pass


def _stderr(msg):
    """Log a refresher diagnostic to stderr. Stays out of the structured
    trace so it doesn't get parsed as a typed event, but still ends up
    in the run's captured output for forensic review."""
    try:
        print("[snowflake-token-refresh] " + str(msg), file=sys.stderr, flush=True)
    except Exception:
        pass


def _resolve_interval():
    """Read and clamp the configured refresh interval. Returns the
    default on parse failure rather than letting a typo crash the thread
    spawn path."""
    raw = os.environ.get("SPCS_TOKEN_REFRESH_INTERVAL_SECS", "").strip()
    if not raw:
        return DEFAULT_INTERVAL_SECS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        _stderr(
            "SPCS_TOKEN_REFRESH_INTERVAL_SECS=" + raw + " is not an integer; "
            "using default " + str(DEFAULT_INTERVAL_SECS) + "s"
        )
        return DEFAULT_INTERVAL_SECS
    # Clamp to a sane window. Below 30s is silly (token rotation is
    # hourly); above 3600s defeats the purpose.
    if value < MIN_INTERVAL_SECS:
        return MIN_INTERVAL_SECS
    if value > MAX_INTERVAL_SECS:
        return MAX_INTERVAL_SECS
    return value


def _read_token_file():
    """Single FS read. Returns the trimmed token string, or None on any
    failure (file missing, unreadable, empty). Errors are logged to
    stderr but never raised — the thread must survive transient
    filesystem hiccups (volume re-mount during rotation, etc.)."""
    try:
        with open(SPCS_TOKEN_PATH, "r", encoding="utf-8") as fp:
            content = fp.read().strip()
    except FileNotFoundError:
        # SPCS could be re-mounting mid-rotation. Silent skip — next
        # iteration will retry.
        return None
    except (OSError, PermissionError) as exc:
        _stderr(
            "could not read " + SPCS_TOKEN_PATH + ": "
            + type(exc).__name__ + ": " + str(exc)
        )
        return None
    if not content:
        return None
    return content


def _refresh(state):
    """One refresh cycle. Reads the mounted token, diffs against the
    cached value, and mutates os.environ['SNOWFLAKE_JWT'] if the value
    changed. state is a dict carrying {'last': <last-read-token-or-None>}
    across iterations.

    LiteLLM's Snowflake provider reads SNOWFLAKE_JWT from os.environ
    lazily per request, so mutating the env is sufficient. If a future
    LiteLLM version starts caching the JWT at client construction,
    we'll need to add explicit client invalidation here.

    TODO: verify LiteLLM re-reads SNOWFLAKE_JWT per request; if not, add
    explicit client invalidation (e.g. litellm cache clear).
    """
    fresh = _read_token_file()
    if fresh is None:
        # File temporarily unavailable — keep the previous env value
        # in place; next iteration retries.
        return

    if fresh == state.get("last"):
        # No-op: token unchanged since last read. Most iterations hit
        # this branch — SPCS rotates ~hourly, the refresher polls every
        # 5 min.
        return

    # Token rotated (or this is the first refresh after startup).
    # Preserve the original prefix shape: a value that started with
    # 'pat/' came from local PAT mode and we should NOT have spawned the
    # refresher at all (PATs don't rotate). The SPCS session token is a
    # raw OAuth bearer with no prefix — pass it through verbatim.
    existing = os.environ.get("SNOWFLAKE_JWT", "")
    if existing.startswith("pat/"):
        # Defensive: refuse to overwrite a PAT-style env value with a
        # raw OAuth bearer. This would produce credential confusion
        # (LiteLLM would send the wrong tokenType header). Log and skip.
        _stderr(
            "refusing to overwrite SNOWFLAKE_JWT: existing value uses pat/ "
            "prefix but SPCS session token is raw OAuth. Daemon should not "
            "have been started in PAT mode."
        )
        return

    os.environ["SNOWFLAKE_JWT"] = fresh
    state["last"] = fresh
    _trace("info", "refreshed SPCS session token")


def _loop(interval_secs):
    """Daemon-thread main loop. Sleeps first so we don't immediately
    re-read the token the Node runner just forwarded — the initial value
    is already in os.environ and known-fresh. Loops forever; thread
    death must be impossible (broad except in the body)."""
    state = {"last": os.environ.get("SNOWFLAKE_JWT") or None}
    while True:
        try:
            time.sleep(interval_secs)
            _refresh(state)
        except Exception as exc:  # pragma: no cover - defensive
            # Broad except: anything from os.environ assignment failing
            # under odd platforms to a future Python raising on a closed
            # stdout. The daemon must NEVER die.
            try:
                _stderr(
                    "refresh iteration failed: " + type(exc).__name__ + ": " + str(exc)
                )
            except Exception:
                pass


def start_token_refresh_thread():
    """Entry point — call this once at crew-process startup.

    Returns immediately and is a true no-op when:
      - /snowflake/session/token does not exist (local PAT/JWT mode),
      - SPCS_TOKEN_REFRESH_ENABLED is set to '0' (operator disable),
      - the thread has already been started this process.

    Otherwise spawns a single daemon thread (daemon=True so it doesn't
    block process exit) that runs _loop forever.
    """
    global _THREAD_STARTED

    # Operator kill-switch. Set SPCS_TOKEN_REFRESH_ENABLED=0 to disable
    # the refresher even inside SPCS (useful for debugging or for short
    # crews where the rotation race is irrelevant).
    if os.environ.get("SPCS_TOKEN_REFRESH_ENABLED", "").strip() == "0":
        return

    # Local-mode short-circuit. The token file is mounted by SPCS; its
    # absence is the cleanest signal that we're running locally and
    # should do nothing at all.
    if not os.path.exists(SPCS_TOKEN_PATH):
        return

    with _LATCH_LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True

    interval = _resolve_interval()
    thread = threading.Thread(
        target=_loop,
        args=(interval,),
        name="snowflake-token-refresh",
        daemon=True,
    )
    thread.start()
    _trace(
        "info",
        "started SPCS session token refresh daemon",
        intervalSecs=interval,
    )
`;

/**
 * Filename for the emitted refresh module inside the run's materialized
 * project directory. Exposed as a helper so the bundler and any future
 * inspection code don't drift from the actual on-disk name.
 */
export function getSnowflakeTokenRefreshFilename(): string {
  return 'snowflake_token_refresh.py';
}
