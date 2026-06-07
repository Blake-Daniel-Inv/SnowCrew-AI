// Embedded SubCrewTool Python source, interpolated into crew.py when
// a workspace defines any SubCrewInvocation (PR 20). Mirrors the style
// of github-tool.py.ts and snowflake-tool.py.ts: a single BaseTool
// subclass, stdlib-only (os, json, typing), and every exception path
// converts to a string return — never a crash that takes down the
// parent crew.
//
// Two safety nets the tool enforces at the Python layer regardless of
// what the LLM tries to do:
//   1. Per-instance invocation budget. Each SubCrewTool instance tracks
//      `_calls_made`; on call N+1 it short-circuits with a "budget
//      exhausted" message instead of kicking off another crew run.
//   2. Recursion depth cap. The env var `SUBCREW_NESTING_DEPTH` is
//      incremented for each nested kickoff. If the current depth is
//      already at MAX_NESTING_DEPTH (5), the tool refuses to fire.
//      This stops a Coordinator from accidentally building an infinite
//      tower of nested crews.
//
// A structured trace line is emitted on every successful kickoff so the
// nested-telemetry feature in PR γ can correlate sub-crew calls back
// to parent runs. PR γ standardizes on the same \`type:\` discriminator
// that all other trace events use (the Node parser switches on
// \`payload.type\`), so this emits:
//   @@TRACE@@ {"type":"subcrew_call","title":"…","detail":"…",
//              "metadata":{"parentInvocationId":"<id>",
//                          "invocationDepth":<depth>,
//                          "invocationNumber":N,"invocationTotal":<max>,
//                          "target":"<crew_name>"}}
// A matching \`type:"subcrew_complete"\` is emitted once the kickoff
// returns. The two together delimit the window during which events
// emitted from inside the sub-crew get tagged with the parent
// invocation id by the Node-side trace-parser context stack.

export const SUBCREW_TOOL_PY = `import json
import os
from typing import Any, Callable, Dict, Optional, Type

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr
from crewai.tools import BaseTool


# Hard ceiling on how deeply Coordinator crews may nest. Matches
# SUBCREW_LIMITS.MAX_NESTING_DEPTH on the TypeScript side. Keeping
# this constant near the top of the file so a code reviewer doesn't
# need to chase imports to confirm the cap.
MAX_NESTING_DEPTH = 5

# Env var the tool reads at call time to determine current nesting
# depth. The runner (PR γ) and this tool both honor the same key;
# missing == 0 == top-level invocation.
NESTING_DEPTH_ENV = "SUBCREW_NESTING_DEPTH"

SUBCREW_TRACE_PREFIX = "@@TRACE@@"


class _SubCrewToolArgs(BaseModel):
    """Free-form inputs forwarded verbatim to target_crew.kickoff(inputs=...).

    The schema is permissive on purpose: a SubCrewTool's contract is
    that the lead agent crafts inputs aligned with the documented
    inputMapping (the invocation's description-time hint). CrewAI's
    arg-binding still validates types against any inputs the target
    crew declares, so genuinely-malformed payloads fail loudly inside
    target_crew.kickoff rather than silently mutating state here.
    """

    model_config = ConfigDict(extra="allow")


def _current_nesting_depth() -> int:
    """Read the current depth from env, defaulting to 0 (top level)
    when unset or non-numeric. We never trust the env value blindly:
    a malformed value collapses to 0, which is the safest default
    (allows the call to proceed, then increments to 1)."""
    raw = os.environ.get(NESTING_DEPTH_ENV, "0").strip()
    try:
        depth = int(raw)
    except (TypeError, ValueError):
        return 0
    return max(0, depth)


# PR 33 — dedicated trace stream. The Python child writes structured
# trace events to FD 3 so LLM-authored output on stdout (runbooks,
# postmortems about this very system, etc.) cannot corrupt the trace
# stream by emitting a literal "@@TRACE@@" string. The Node-side spawn
# wires FD 3 as a pipe; if the FD is not open (legacy callers, tests
# running the file directly), we fall back to stdout with a one-time
# deprecation marker so trace consumers still see the event but the
# operator knows to update their integration.
_TRACE_FD = 3
_TRACE_FALLBACK_WARNED = False


def _emit_trace(payload: Dict[str, Any]) -> None:
    """Write a single trace line via the dedicated FD 3 stream. Falls
    back to stdout (with a one-shot deprecation marker) if FD 3 is
    not open. Never raises — a broken trace stream must not crash the
    sub-crew kickoff."""
    global _TRACE_FALLBACK_WARNED
    try:
        line = SUBCREW_TRACE_PREFIX + " " + json.dumps(payload, default=str)
        try:
            os.write(_TRACE_FD, (line + "\\n").encode("utf-8"))
            return
        except OSError:
            # FD 3 not open (test mode / legacy spawn). Fall back to
            # stdout but tag the first such emission so the Node side
            # logs a "trace on stdout — should be on FD 3" warning.
            if not _TRACE_FALLBACK_WARNED:
                _TRACE_FALLBACK_WARNED = True
                try:
                    print(
                        SUBCREW_TRACE_PREFIX
                        + ' {"type":"warning","title":"trace on stdout (FD 3 unavailable)","detail":"Python emitted trace on stdout; FD 3 fallback","metadata":{}}',
                        flush=True,
                    )
                except Exception:  # pragma: no cover - defensive
                    pass
            print(line, flush=True)
    except Exception:  # pragma: no cover - defensive
        pass


# Process-global per-invocation budget. Keyed by self._invocation_id so
# CrewAI re-instantiating the SubCrewTool across delegations/retries
# still hits the same counter. NOT cleared on tool teardown — the
# subprocess is one-shot per crew run, so the dict's lifetime matches
# the invocation's lifetime.
_BUDGET_BY_INVOCATION: Dict[str, int] = {}


class SubCrewTool(BaseTool):
    """A tool wrapping a kickoff of another crew in this workspace.

    Each instance is bound to one SubCrewInvocation. The lead agent
    invokes the tool with kwargs; we forward those to
    target_crew.kickoff(inputs=kwargs) and return the result string.

    Budget + depth enforcement:
      - self._calls_made starts at 0 and increments after each
        successful kickoff. The (N+1)th call returns a clear "budget
        exhausted" string instead of running.
      - SUBCREW_NESTING_DEPTH is checked BEFORE the kickoff. If we're
        already at MAX_NESTING_DEPTH (5), the call refuses and we
        do not increment the counter (the depth + the budget are
        independent counters with different semantics).

    Trace emission happens AFTER a successful kickoff so failures
    don't pollute the trace stream with phantom calls.
    """

    # Pydantic v2 / CrewAI BaseTool stores invocation-specific fields
    # as private attrs so they don't conflict with the framework's
    # serialized public surface.
    _invocation_id: str = PrivateAttr(default="")
    _target_crew_factory: Optional[Callable[[], Any]] = PrivateAttr(default=None)
    _max_invocations: int = PrivateAttr(default=1)
    _success_criteria: Optional[str] = PrivateAttr(default=None)
    # PR 33 — _calls_made was a PrivateAttr that reset to 0 every time
    # CrewAI re-instantiated the tool (planner retries, sub-agent
    # delegations, etc.), defeating the per-invocation budget. The
    # process-global _BUDGET_BY_INVOCATION dict above is keyed by the
    # invocation_id so all instances bound to the same invocation share
    # one counter.

    name: str = "subcrew"
    description: str = "Calls a sub-crew. Use with care; the lead agent should observe the output and refine inputs as needed."
    args_schema: Type[BaseModel] = _SubCrewToolArgs

    def __init__(
        self,
        *,
        invocation_id: str,
        display_name: str,
        description: str,
        target_crew_factory: Callable[[], Any],
        max_invocations: int,
        success_criteria: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        # The base description from the invocation, augmented at call
        # time with a "Calls remaining" suffix so the LLM sees its
        # budget every time it inspects the toolbox.
        budget_suffix = (
            " Calls remaining: " + str(max_invocations) + " of " + str(max_invocations) + "."
        )
        criteria_suffix = ""
        if success_criteria:
            criteria_suffix = " Success rubric: " + success_criteria.strip()
        full_description = (description or "Calls a sub-crew.").strip() + budget_suffix + criteria_suffix

        super().__init__(
            name=display_name or "subcrew",
            description=full_description,
            **kwargs,
        )
        self._invocation_id = invocation_id
        self._target_crew_factory = target_crew_factory
        # Clamp at construction in case caller passes garbage; cheap
        # defense-in-depth alongside the TS-side schema cap.
        try:
            cap = int(max_invocations)
        except (TypeError, ValueError):
            cap = 1
        self._max_invocations = max(1, min(MAX_NESTING_DEPTH * 100, cap))
        self._success_criteria = success_criteria
        # Seed the budget entry so a brand-new invocation starts at 0
        # without clobbering an existing counter (re-instantiation case).
        _BUDGET_BY_INVOCATION.setdefault(self._invocation_id, 0)

    def _calls_made_count(self) -> int:
        """Read the process-global per-invocation counter. Returns 0
        when the entry is missing (legacy / test instantiation without
        going through __init__'s setdefault)."""
        return _BUDGET_BY_INVOCATION.get(self._invocation_id, 0)

    def _refresh_description(self) -> None:
        """Recompute the description string so the budget reflects
        calls already made. Useful between kickoffs when the LLM
        inspects the tool list."""
        remaining = self._max_invocations - self._calls_made_count()
        budget_suffix = (
            " Calls remaining: " + str(max(0, remaining))
            + " of " + str(self._max_invocations) + "."
        )
        criteria_suffix = ""
        if self._success_criteria:
            criteria_suffix = " Success rubric: " + self._success_criteria.strip()
        # description on BaseTool is settable; rewrite in place.
        try:
            self.description = (self.description.split(" Calls remaining:")[0]).strip() + budget_suffix + criteria_suffix
        except Exception:  # pragma: no cover - defensive
            pass

    def _run(self, **kwargs: Any) -> str:
        # 1) Depth check FIRST so a malicious / runaway prompt can't
        #    keep racking up budget while we're already 5 deep.
        depth = _current_nesting_depth()
        if depth >= MAX_NESTING_DEPTH:
            return (
                "Sub-crew refused: maximum nesting depth ("
                + str(MAX_NESTING_DEPTH)
                + ") already reached. The lead agent is "
                + str(depth)
                + " levels deep; no further sub-crew kickoffs allowed. "
                + "Return your best result up to this point."
            )

        # 2) Budget check. The process-global dict survives
        #    CrewAI re-instantiating the tool, so the counter is
        #    authoritative across delegations / retries / re-prompts.
        if self._calls_made_count() >= self._max_invocations:
            return (
                "Tool budget exhausted. You called this "
                + str(self._max_invocations)
                + " times; no more invocations allowed. "
                + "Move on with the best result you have."
            )

        if self._target_crew_factory is None:
            return "Sub-crew misconfigured: no target factory bound."

        # 3) Build the env for the sub-crew so its own SubCrewTools
        #    see the incremented depth. We don't mutate os.environ
        #    here for the duration of the kickoff because CrewAI runs
        #    sub-crews in-process — setting the env var globally is
        #    safe as long as we restore it on exit. Using a try/finally
        #    is critical: an exception inside the kickoff must not
        #    leave the env at depth+1 for downstream calls.
        prior = os.environ.get(NESTING_DEPTH_ENV)
        os.environ[NESTING_DEPTH_ENV] = str(depth + 1)
        try:
            target_crew = None
            try:
                target_crew = self._target_crew_factory()
            except Exception as exc:
                return (
                    "Sub-crew factory failed: "
                    + type(exc).__name__
                    + ": "
                    + str(exc)
                )

            if target_crew is None or not hasattr(target_crew, "kickoff"):
                return (
                    "Sub-crew factory returned an object without a kickoff() method; "
                    + "this indicates a generator bug — please file an issue."
                )

            try:
                result = target_crew.kickoff(inputs=kwargs)
            except Exception as exc:
                # Don't increment budget on failure — the LLM may want
                # to retry with different inputs and we'd rather not
                # punish it for transient errors. The trace emission
                # is also skipped so PR γ telemetry doesn't see a
                # phantom call.
                return (
                    "Sub-crew kickoff error: "
                    + type(exc).__name__
                    + ": "
                    + str(exc)
                )
        finally:
            # Restore previous env value so sibling tool calls don't
            # see the elevated depth.
            if prior is None:
                os.environ.pop(NESTING_DEPTH_ENV, None)
            else:
                os.environ[NESTING_DEPTH_ENV] = prior

        # 4) Success path: bump counter, refresh description, emit trace.
        _BUDGET_BY_INVOCATION[self._invocation_id] = self._calls_made_count() + 1
        self._refresh_description()

        target_name = getattr(target_crew, "name", None) or ""
        # The depth recorded on the trace event is the depth THIS call
        # ran AT (post-increment view) - one deeper than the parent
        # that fired it. The Node trace-parser uses this for UI
        # indentation and to push the right frame onto the context
        # stack so events emitted by the sub-crew inherit the parent
        # invocation id.
        emitted_depth = depth + 1
        calls_made_now = self._calls_made_count()
        _emit_trace({
            "type": "subcrew_call",
            "title": "Sub-crew kickoff " + str(calls_made_now) + "/" + str(self._max_invocations),
            "detail": ("Target: " + target_name) if target_name else "Sub-crew kickoff",
            "metadata": {
                "parentInvocationId": self._invocation_id,
                "invocationDepth": emitted_depth,
                "invocationNumber": calls_made_now,
                "invocationTotal": self._max_invocations,
                "target": target_name,
            },
        })

        # 5) Emit the matching subcrew_complete so the Node-side
        #    context stack can pop. The Node parser uses this as the
        #    explicit end-of-window marker rather than guessing from
        #    the next top-level event - keeps the nesting deterministic
        #    even when interleaved logs land between kickoffs.
        _emit_trace({
            "type": "subcrew_complete",
            "title": "Sub-crew complete " + str(calls_made_now) + "/" + str(self._max_invocations),
            "detail": ("Returned from " + target_name) if target_name else "Sub-crew finished",
            "metadata": {
                "parentInvocationId": self._invocation_id,
                "invocationDepth": emitted_depth,
                "invocationNumber": calls_made_now,
                "invocationTotal": self._max_invocations,
                "target": target_name,
            },
        })

        # 6) Coerce result to a string for the LLM. CrewAI may return
        #    a CrewOutput-like object; str() captures whatever its
        #    __str__ exposes (the final output text by convention).
        try:
            return str(result)
        except Exception as exc:  # pragma: no cover - defensive
            return "Sub-crew result stringification error: " + type(exc).__name__ + ": " + str(exc)
`;

/**
 * Filename for the emitted sub-crew tool module inside the run's
 * materialized project directory. Exposed as a helper so the bundler
 * and any future inspection code don't drift from the actual on-disk
 * name. Mirrors `getGitHubToolFilename` / Snowflake-tool conventions.
 */
export function getSubCrewToolFilename(): string {
  return 'subcrew_tool.py';
}
