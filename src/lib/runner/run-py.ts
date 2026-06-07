// Python runner source — extracted verbatim from crew-runner.ts. Ships byte-identical.

/**
 * Python script that loads the generated crew.py and runs it with
 * instrumented callbacks that emit @@TRACE@@ JSON lines for the Node
 * side to parse into structured events.
 */
export const RUNNER_SCRIPT = `import importlib.util
import json
import os
import sys
import traceback

TRACE_PREFIX = "@@TRACE@@ "

def emit(event_type, title, **extra):
    payload = {"type": event_type, "title": title}
    payload.update({k: v for k, v in extra.items() if v is not None})
    print(TRACE_PREFIX + json.dumps(payload), flush=True)

def log(msg):
    print(msg, flush=True)

def load_inputs():
    try:
        with open("inputs.json", "r", encoding="utf-8") as fp:
            return json.load(fp)
    except Exception:
        return {}

def load_studio_map():
    try:
        with open("studio-map.json", "r", encoding="utf-8") as fp:
            return json.load(fp)
    except Exception:
        return {"tasks": [], "agents": []}

STUDIO_MAP = load_studio_map()

def norm(value):
    return str(value or "").strip().lower()

def as_text(value, limit=400):
    if value is None:
        return None
    try:
        raw = getattr(value, "raw", None)
        text = str(raw if raw is not None else value)
    except Exception:
        text = repr(value)
    return text[:limit]

def task_display_name(task, event=None):
    for obj in (event, task):
        if obj is None:
            continue
        for attr in ("task_name", "name", "description", "id"):
            value = getattr(obj, attr, None)
            if value:
                return str(value)
    return "task"

def agent_display_name(agent, event=None):
    for obj in (event, agent):
        if obj is None:
            continue
        for attr in ("agent_role", "role", "name", "id"):
            value = getattr(obj, attr, None)
            if value:
                return str(value)
    return "agent"

def studio_task_for(task=None, event=None):
    candidates = []
    for obj in (event, task):
        if obj is None:
            continue
        for attr in ("task_id", "task_name", "id", "name", "description"):
            value = getattr(obj, attr, None)
            if value:
                candidates.append(str(value))

    for item in STUDIO_MAP.get("tasks", []):
        values = [item.get("id"), item.get("key"), item.get("name"), item.get("description")]
        if any(norm(candidate) == norm(value) for candidate in candidates for value in values):
            return item
    return None

def studio_agent_for(agent=None, event=None):
    candidates = []
    for obj in (event, agent):
        if obj is None:
            continue
        for attr in ("agent_id", "agent_key", "agent_role", "id", "key", "name", "role"):
            value = getattr(obj, attr, None)
            if value:
                candidates.append(str(value))

    for item in STUDIO_MAP.get("agents", []):
        values = [item.get("id"), item.get("key"), item.get("name"), item.get("role")]
        if any(norm(candidate) == norm(value) for candidate in candidates for value in values):
            return item
    return None

CONTEXT_AGENT = {"id": None, "name": None}
CONTEXT_TASK = {"id": None, "name": None}
LLM_CALL_STARTED_AT = {}

def extract_usage(event):
    """Best-effort token-count extraction across CrewAI / LiteLLM shapes."""
    candidates = []
    for attr in ("usage", "token_usage", "response_usage"):
        value = getattr(event, attr, None)
        if value is not None:
            candidates.append(value)
    response = getattr(event, "response", None)
    if response is not None:
        for attr in ("usage", "token_usage"):
            value = getattr(response, attr, None)
            if value is not None:
                candidates.append(value)

    for usage in candidates:
        prompt = (
            getattr(usage, "prompt_tokens", None)
            or (usage.get("prompt_tokens") if isinstance(usage, dict) else None)
            or 0
        )
        completion = (
            getattr(usage, "completion_tokens", None)
            or (usage.get("completion_tokens") if isinstance(usage, dict) else None)
            or 0
        )
        total = (
            getattr(usage, "total_tokens", None)
            or (usage.get("total_tokens") if isinstance(usage, dict) else None)
            or (prompt + completion)
            or 0
        )
        if prompt or completion or total:
            return {"prompt": int(prompt), "completion": int(completion), "total": int(total)}
    return None

def install_event_handlers():
    try:
        from crewai.events import crewai_event_bus
        from crewai.events.types.task_events import TaskStartedEvent, TaskCompletedEvent, TaskFailedEvent
        from crewai.events.types.agent_events import AgentExecutionStartedEvent, AgentExecutionCompletedEvent, AgentExecutionErrorEvent
        from crewai.events.types.tool_usage_events import ToolUsageStartedEvent, ToolUsageFinishedEvent, ToolUsageErrorEvent
    except Exception as exc:
        emit("warning", "CrewAI event bus unavailable", detail=f"{type(exc).__name__}: {exc}")
        return

    # LLM events live in a sibling module that's been renamed across
    # CrewAI versions. Try the modern path first, fall back gracefully.
    LLMCallStartedEvent = LLMCallCompletedEvent = LLMCallFailedEvent = None
    for module_path in (
        "crewai.events.types.llm_events",
        "crewai.events.types.llm_guardrail_events",
    ):
        try:
            module = __import__(module_path, fromlist=["*"])
            LLMCallStartedEvent = getattr(module, "LLMCallStartedEvent", LLMCallStartedEvent)
            LLMCallCompletedEvent = getattr(module, "LLMCallCompletedEvent", LLMCallCompletedEvent)
            LLMCallFailedEvent = getattr(module, "LLMCallFailedEvent", LLMCallFailedEvent)
        except Exception:
            continue

    @crewai_event_bus.on(TaskStartedEvent)
    def on_task_started(source, event):
        try:
            task = getattr(event, "task", None) or source
            studio_task = studio_task_for(task, event)
            agent_id = studio_task.get("agentId") if studio_task else None
            task_id = studio_task.get("id") if studio_task else getattr(event, "task_id", None)
            name = studio_task.get("name") if studio_task else task_display_name(task, event)
            CONTEXT_TASK["id"] = task_id
            CONTEXT_TASK["name"] = name
            emit(
                "task_started",
                "Task started",
                taskName=name,
                taskId=task_id,
                agentId=agent_id,
                nodeId=task_id,
                phase="running",
            )
        except Exception as exc:
            emit("warning", "Task event handling failed", detail=str(exc))

    @crewai_event_bus.on(TaskCompletedEvent)
    def on_task_completed(source, event):
        try:
            task = getattr(event, "task", None) or source
            studio_task = studio_task_for(task, event)
            agent_id = studio_task.get("agentId") if studio_task else None
            task_id = studio_task.get("id") if studio_task else getattr(event, "task_id", None)
            name = studio_task.get("name") if studio_task else task_display_name(task, event)
            emit(
                "task_completed",
                "Task completed",
                taskName=name,
                taskId=task_id,
                agentId=agent_id,
                nodeId=task_id,
                phase="completed",
                detail=as_text(getattr(event, "output", None)),
            )
        except Exception as exc:
            emit("warning", "Task event handling failed", detail=str(exc))

    @crewai_event_bus.on(TaskFailedEvent)
    def on_task_failed(source, event):
        try:
            task = getattr(event, "task", None) or source
            studio_task = studio_task_for(task, event)
            agent_id = studio_task.get("agentId") if studio_task else None
            task_id = studio_task.get("id") if studio_task else getattr(event, "task_id", None)
            name = studio_task.get("name") if studio_task else task_display_name(task, event)
            emit(
                "task_failed",
                "Task failed",
                taskName=name,
                taskId=task_id,
                agentId=agent_id,
                nodeId=task_id,
                phase="failed",
                detail=as_text(getattr(event, "error", None)),
            )
        except Exception as exc:
            emit("warning", "Task event handling failed", detail=str(exc))

    @crewai_event_bus.on(AgentExecutionStartedEvent)
    def on_agent_started(source, event):
        try:
            agent = getattr(event, "agent", None) or source
            task = getattr(event, "task", None)
            studio_agent = studio_agent_for(agent, event)
            studio_task = studio_task_for(task, event)
            agent_id = studio_agent.get("id") if studio_agent else getattr(event, "agent_id", None)
            agent_name = studio_agent.get("name") if studio_agent else agent_display_name(agent, event)
            CONTEXT_AGENT["id"] = agent_id
            CONTEXT_AGENT["name"] = agent_name
            if studio_task:
                CONTEXT_TASK["id"] = studio_task.get("id")
                CONTEXT_TASK["name"] = studio_task.get("name")
            emit(
                "agent_started",
                "Agent started",
                agentName=agent_name,
                agentId=agent_id,
                taskName=(studio_task.get("name") if studio_task else task_display_name(task, event) if task else None),
                taskId=(studio_task.get("id") if studio_task else None),
                nodeId=agent_id,
                phase="running",
            )
        except Exception as exc:
            emit("warning", "Agent event handling failed", detail=str(exc))

    @crewai_event_bus.on(AgentExecutionCompletedEvent)
    def on_agent_completed(source, event):
        try:
            agent = getattr(event, "agent", None) or source
            task = getattr(event, "task", None)
            studio_agent = studio_agent_for(agent, event)
            studio_task = studio_task_for(task, event)
            agent_id = studio_agent.get("id") if studio_agent else getattr(event, "agent_id", None)
            emit(
                "agent_completed",
                "Agent completed",
                agentName=(studio_agent.get("name") if studio_agent else agent_display_name(agent, event)),
                agentId=agent_id,
                taskName=(studio_task.get("name") if studio_task else task_display_name(task, event) if task else None),
                taskId=(studio_task.get("id") if studio_task else None),
                nodeId=agent_id,
                phase="completed",
                detail=as_text(getattr(event, "output", None)),
            )
        except Exception as exc:
            emit("warning", "Agent event handling failed", detail=str(exc))

    @crewai_event_bus.on(AgentExecutionErrorEvent)
    def on_agent_failed(source, event):
        try:
            agent = getattr(event, "agent", None) or source
            task = getattr(event, "task", None)
            studio_agent = studio_agent_for(agent, event)
            studio_task = studio_task_for(task, event)
            agent_id = studio_agent.get("id") if studio_agent else getattr(event, "agent_id", None)
            emit(
                "agent_failed",
                "Agent failed",
                agentName=(studio_agent.get("name") if studio_agent else agent_display_name(agent, event)),
                agentId=agent_id,
                taskName=(studio_task.get("name") if studio_task else task_display_name(task, event) if task else None),
                taskId=(studio_task.get("id") if studio_task else None),
                nodeId=agent_id,
                phase="failed",
                detail=as_text(getattr(event, "error", None)),
            )
        except Exception as exc:
            emit("warning", "Agent event handling failed", detail=str(exc))

    @crewai_event_bus.on(ToolUsageStartedEvent)
    def on_tool_started(source, event):
        try:
            emit(
                "tool_call",
                f"Tool started: {getattr(event, 'tool_name', 'tool')}",
                toolName=getattr(event, "tool_name", None),
                taskName=getattr(event, "task_name", None),
                agentName=getattr(event, "agent_role", None),
                detail=as_text(getattr(event, "tool_args", None), 600),
            )
        except Exception:
            pass

    @crewai_event_bus.on(ToolUsageFinishedEvent)
    def on_tool_finished(source, event):
        try:
            emit(
                "tool_result",
                f"Tool completed: {getattr(event, 'tool_name', 'tool')}",
                toolName=getattr(event, "tool_name", None),
                taskName=getattr(event, "task_name", None),
                agentName=getattr(event, "agent_role", None),
                detail=as_text(getattr(event, "output", None), 600),
            )
        except Exception:
            pass

    @crewai_event_bus.on(ToolUsageErrorEvent)
    def on_tool_error(source, event):
        try:
            emit(
                "warning",
                f"Tool failed: {getattr(event, 'tool_name', 'tool')}",
                toolName=getattr(event, "tool_name", None),
                taskName=getattr(event, "task_name", None),
                agentName=getattr(event, "agent_role", None),
                detail=as_text(getattr(event, "error", None), 600),
            )
        except Exception:
            pass

    # LLM call instrumentation. CrewAI's event bus emits Started/Completed
    # around every LiteLLM call, so we use this to attribute token spend
    # back to the agent/task that was active at the time.
    if LLMCallStartedEvent is not None:
        import time as _time

        @crewai_event_bus.on(LLMCallStartedEvent)
        def on_llm_started(source, event):
            try:
                key = id(event)
                LLM_CALL_STARTED_AT[key] = _time.monotonic()
            except Exception:
                pass

        if LLMCallCompletedEvent is not None:
            @crewai_event_bus.on(LLMCallCompletedEvent)
            def on_llm_completed(source, event):
                try:
                    usage = extract_usage(event)
                    if not usage:
                        return
                    started = LLM_CALL_STARTED_AT.pop(id(event), None)
                    latency_ms = (
                        int((_time.monotonic() - started) * 1000)
                        if started is not None
                        else None
                    )
                    model = (
                        getattr(event, "model", None)
                        or getattr(getattr(event, "response", None), "model", None)
                        or "unknown"
                    )
                    emit(
                        "token_usage",
                        f"LLM call: {usage['total']} tokens",
                        detail=f"{usage['prompt']} prompt + {usage['completion']} completion",
                        agentId=CONTEXT_AGENT.get("id"),
                        agentName=CONTEXT_AGENT.get("name"),
                        taskId=CONTEXT_TASK.get("id"),
                        taskName=CONTEXT_TASK.get("name"),
                        toolName=str(model),
                        tokens=usage["total"],
                        promptTokens=usage["prompt"],
                        completionTokens=usage["completion"],
                        latencyMs=latency_ms,
                    )
                except Exception as exc:
                    emit("warning", "LLM token capture failed", detail=str(exc))

        if LLMCallFailedEvent is not None:
            @crewai_event_bus.on(LLMCallFailedEvent)
            def on_llm_failed(source, event):
                try:
                    LLM_CALL_STARTED_AT.pop(id(event), None)
                except Exception:
                    pass

def main():
    # crewai requires Python 3.10+ (uses PEP 604 union syntax internally).
    if sys.version_info < (3, 10):
        emit(
            "run_errored",
            f"Python {sys.version_info.major}.{sys.version_info.minor} is too old",
            detail=(
                "crewai requires Python 3.10 or newer. Install a newer Python and "
                "point the app at it via the CREW_PYTHON_BIN environment variable, "
                "e.g. export CREW_PYTHON_BIN=$(which python3.12)"
            ),
        )
        sys.exit(2)

    try:
        import crewai  # noqa: F401
    except ModuleNotFoundError as exc:
        emit(
            "run_errored",
            "crewai package not installed",
            detail=(
                f"{exc}. Install in the same Python the app uses: "
                f"{sys.executable} -m pip install crewai crewai-tools"
            ),
        )
        sys.exit(2)
    except Exception as exc:
        emit(
            "run_errored",
            "crewai failed to import",
            detail=f"{type(exc).__name__}: {exc}",
        )
        sys.exit(2)

    install_event_handlers()

    spec = importlib.util.spec_from_file_location("crew_module", "crew.py")
    module = importlib.util.module_from_spec(spec)

    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        emit("run_errored", "Failed to import crew.py", detail=str(exc))
        traceback.print_exc()
        sys.exit(3)

    # Strategy 1: the Node runner tells us the exact class name it generated.
    # Strategy 2 (fallback): scan module for a locally-defined class that
    # exposes a callable .crew method.
    expected_name = os.environ.get("CREW_CLASS_NAME", "").strip() or None
    crew_class = None

    if expected_name and isinstance(getattr(module, expected_name, None), type):
        candidate = getattr(module, expected_name)
        if callable(getattr(candidate, "crew", None)):
            crew_class = candidate

    if crew_class is None:
        for attr, obj in vars(module).items():
            if not isinstance(obj, type):
                continue
            if getattr(obj, "__module__", None) != module.__name__:
                continue
            if not callable(getattr(obj, "crew", None)):
                continue
            crew_class = obj
            break

    if crew_class is None:
        emit(
            "run_errored",
            "Could not find crew class in crew.py",
            detail=("Expected class "
                    + (expected_name or "<auto>")
                    + "; scanned module for a class with a callable .crew method and found none."),
        )
        sys.exit(4)

    try:
        instance = crew_class()
        crew = instance.crew()
        for task in getattr(crew, "tasks", []) or []:
            try:
                task.human_input = os.environ.get("CREWAI_STUDIO_ALLOW_HUMAN_INPUT") == "true"
            except Exception:
                pass
    except Exception as exc:
        emit("run_errored", "Crew instantiation failed", detail=str(exc))
        traceback.print_exc()
        sys.exit(5)

    inputs = load_inputs()
    try:
        result = crew.kickoff(inputs=inputs) if inputs else crew.kickoff()
    except Exception as exc:
        emit("run_errored", "kickoff() raised", detail=str(exc))
        traceback.print_exc()
        sys.exit(6)

    log("\\n===== FINAL OUTPUT =====\\n")
    log(str(result))
    emit("run_completed", "Crew completed")

if __name__ == "__main__":
    main()
`;
