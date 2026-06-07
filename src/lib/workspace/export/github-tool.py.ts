// Embedded GitHubTool Python source, interpolated into crew.py when any
// agent declares the `github` tool. The Python module reads its token
// from the GITHUB_TOKEN environment variable (injected by the Node runner
// at run start from the per-user encrypted credential store). When the
// env var is unset every method returns a structured error string —
// crews still run, but tool calls surface "credential not configured" so
// the user sees the failure path inside the trace.
//
// Uses urllib.request from the stdlib (no third-party deps) and mirrors
// snowflake-tool.py.ts in style: one BaseTool subclass with a method-name
// dispatch via the args schema. CrewAI binds these by name; the schema's
// `method` field tells the agent which GitHub operation to invoke.

export const GITHUB_TOOL_PY = `import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional, Type

from pydantic import BaseModel, Field
from crewai.tools import BaseTool


GITHUB_API_BASE = "https://api.github.com"
GITHUB_USER_AGENT = "SnowCrewAI"
GITHUB_API_VERSION = "2022-11-28"
GITHUB_REQUEST_TIMEOUT = 30
GITHUB_DIFF_MAX_BYTES = 256 * 1024

GITHUB_MISSING_CREDENTIAL_MSG = (
    "GitHub credential not configured for this user. "
    "Connect at /settings."
)


def _github_token() -> Optional[str]:
    """Read the token at call time (not at import) so a token set after
    module load is still picked up. Trimmed to defend against a trailing
    newline accidentally introduced by shell pipelines."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    return token or None


def _format_rate_limit_error(headers) -> str:
    reset = headers.get("X-RateLimit-Reset") if headers else None
    if reset and str(reset).isdigit():
        try:
            iso = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(reset))
            )
            return f"GitHub rate limit reached; resets at {iso}"
        except (ValueError, OSError):
            pass
    return "GitHub rate limit reached; reset time unavailable"


def _github_request(
    method: str,
    path: str,
    *,
    accept: str = "application/vnd.github+json",
    query: Optional[dict] = None,
) -> tuple[Optional[bytes], Optional[str]]:
    """Make an authenticated GitHub API call. Returns (body, error) where
    exactly one of the two is non-None. Never leaks the token in error
    strings — only the HTTP status code and a generic explanation are
    surfaced to the caller (and therefore to the agent / run log)."""
    token = _github_token()
    if not token:
        return (None, GITHUB_MISSING_CREDENTIAL_MSG)

    url = GITHUB_API_BASE + path
    if query:
        # Drop None values so callers can pass optional params unconditionally.
        clean = {k: v for k, v in query.items() if v is not None and v != ""}
        if clean:
            url = url + "?" + urllib.parse.urlencode(clean)

    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", accept)
    req.add_header("User-Agent", GITHUB_USER_AGENT)
    req.add_header("X-GitHub-Api-Version", GITHUB_API_VERSION)

    try:
        with urllib.request.urlopen(req, timeout=GITHUB_REQUEST_TIMEOUT) as resp:
            return (resp.read(), None)
    except urllib.error.HTTPError as exc:
        status = exc.code
        if status in (401, 403):
            # 403 with a rate-limit header is a rate limit, not an auth failure.
            remaining = exc.headers.get("X-RateLimit-Remaining") if exc.headers else None
            if status == 403 and remaining == "0":
                return (None, _format_rate_limit_error(exc.headers))
            return (
                None,
                f"GitHub returned {status} - token may be revoked or lacks required scope",
            )
        if status == 429:
            return (None, _format_rate_limit_error(exc.headers))
        if 500 <= status < 600:
            return (None, f"GitHub upstream error {status}")
        return (None, f"GitHub returned {status}")
    except urllib.error.URLError as exc:
        return (None, f"GitHub network error: {exc.reason}")
    except (TimeoutError, OSError) as exc:
        return (None, f"GitHub network error: {type(exc).__name__}: {exc}")


def _parse_json(body: bytes) -> tuple[object, Optional[str]]:
    try:
        return (json.loads(body.decode("utf-8")), None)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return (None, f"GitHub response parse error: {type(exc).__name__}: {exc}")


def _project_repo(repo: dict) -> dict:
    return {
        "full_name": repo.get("full_name"),
        "private": repo.get("private"),
        "default_branch": repo.get("default_branch"),
        "description": repo.get("description"),
        "html_url": repo.get("html_url"),
        "language": repo.get("language"),
        "updated_at": repo.get("updated_at"),
    }


def _project_issue(issue: dict) -> dict:
    user = issue.get("user") or {}
    labels = [
        label.get("name") if isinstance(label, dict) else label
        for label in (issue.get("labels") or [])
    ]
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "labels": [label for label in labels if label],
        "user": user.get("login"),
        "html_url": issue.get("html_url"),
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
    }


def _project_pr(pr: dict) -> dict:
    user = pr.get("user") or {}
    base = pr.get("base") or {}
    head = pr.get("head") or {}
    return {
        "number": pr.get("number"),
        "title": pr.get("title"),
        "state": pr.get("state"),
        "body": pr.get("body"),
        "base": base.get("ref"),
        "head": head.get("ref"),
        "user": user.get("login"),
        "additions": pr.get("additions"),
        "deletions": pr.get("deletions"),
        "changed_files": pr.get("changed_files"),
        "html_url": pr.get("html_url"),
        "created_at": pr.get("created_at"),
        "updated_at": pr.get("updated_at"),
    }


class _GitHubToolArgs(BaseModel):
    method: str = Field(
        ...,
        description=(
            "GitHub operation to perform. One of: list_repos, "
            "get_file_contents, get_pull_request, get_pr_diff, list_issues."
        ),
    )
    repo: Optional[str] = Field(
        default=None,
        description="owner/name slug (e.g. 'octocat/Hello-World').",
    )
    owner: Optional[str] = Field(
        default=None,
        description="GitHub username/org for list_repos when listing a different account.",
    )
    path: Optional[str] = Field(
        default=None,
        description="File path within the repo for get_file_contents.",
    )
    ref: Optional[str] = Field(
        default=None,
        description="Branch / tag / SHA for get_file_contents.",
    )
    number: Optional[int] = Field(
        default=None,
        description="Pull request or issue number.",
    )
    state: Optional[str] = Field(
        default="open",
        description="Issue state filter: open, closed, or all.",
    )
    labels: Optional[str] = Field(
        default=None,
        description="Comma-separated label names for list_issues.",
    )
    per_page: Optional[int] = Field(
        default=30,
        description="Results per page (max 100).",
    )


class GitHubTool(BaseTool):
    """CrewAI tool that exposes a small read-only slice of the GitHub REST
    API to agents. The token is taken from GITHUB_TOKEN at call time —
    injected by the Node runner from the per-user encrypted credential
    store. If GITHUB_TOKEN is unset, every method returns a clear error
    string so the user sees the missing-credential path inside the run
    trace instead of a generic 500."""

    name: str = "github"
    description: str = (
        "Read-only GitHub access. Supported methods: list_repos "
        "(current user or a given owner), get_file_contents (returns "
        "decoded UTF-8 file body), get_pull_request (PR metadata), "
        "get_pr_diff (unified diff, truncated at 256 KB), list_issues "
        "(filters PRs out). All calls require a GitHub credential "
        "connected at /settings; without one each call returns an error."
    )
    args_schema: Type[BaseModel] = _GitHubToolArgs

    def _list_repos(
        self,
        owner: Optional[str] = None,
        per_page: int = 30,
    ) -> str:
        path = "/user/repos" if not owner else f"/users/{owner}/repos"
        body, err = _github_request(
            "GET",
            path,
            query={"per_page": min(max(int(per_page or 30), 1), 100)},
        )
        if err is not None:
            return err
        parsed, parse_err = _parse_json(body or b"")
        if parse_err is not None:
            return parse_err
        if not isinstance(parsed, list):
            return "GitHub returned unexpected payload for list_repos"
        return json.dumps([_project_repo(r) for r in parsed if isinstance(r, dict)])

    def _get_file_contents(
        self,
        repo: str,
        path: str,
        ref: Optional[str] = None,
    ) -> str:
        if not repo or "/" not in repo:
            return "get_file_contents requires repo as 'owner/name'"
        if not path:
            return "get_file_contents requires a non-empty path"
        owner, name = repo.split("/", 1)
        api_path = (
            f"/repos/{urllib.parse.quote(owner)}/"
            f"{urllib.parse.quote(name)}/contents/"
            f"{urllib.parse.quote(path)}"
        )
        body, err = _github_request(
            "GET",
            api_path,
            query={"ref": ref} if ref else None,
        )
        if err is not None:
            return err
        parsed, parse_err = _parse_json(body or b"")
        if parse_err is not None:
            return parse_err
        if isinstance(parsed, list):
            return "Path is a directory; pass a file path to get_file_contents."
        if not isinstance(parsed, dict):
            return "GitHub returned unexpected payload for get_file_contents"
        if parsed.get("type") != "file":
            return f"Path is not a file (type={parsed.get('type')})."
        encoding = parsed.get("encoding")
        content = parsed.get("content")
        if encoding != "base64" or not isinstance(content, str):
            return "GitHub returned an unsupported content encoding; file may be too large."
        try:
            raw = base64.b64decode(content)
            return raw.decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return "File is binary or not UTF-8; cannot decode."

    def _get_pull_request(self, repo: str, number: int) -> str:
        if not repo or "/" not in repo:
            return "get_pull_request requires repo as 'owner/name'"
        if not isinstance(number, int) or number <= 0:
            return "get_pull_request requires a positive integer 'number'"
        owner, name = repo.split("/", 1)
        api_path = (
            f"/repos/{urllib.parse.quote(owner)}/"
            f"{urllib.parse.quote(name)}/pulls/{number}"
        )
        body, err = _github_request("GET", api_path)
        if err is not None:
            return err
        parsed, parse_err = _parse_json(body or b"")
        if parse_err is not None:
            return parse_err
        if not isinstance(parsed, dict):
            return "GitHub returned unexpected payload for get_pull_request"
        return json.dumps(_project_pr(parsed))

    def _get_pr_diff(self, repo: str, number: int) -> str:
        if not repo or "/" not in repo:
            return "get_pr_diff requires repo as 'owner/name'"
        if not isinstance(number, int) or number <= 0:
            return "get_pr_diff requires a positive integer 'number'"
        owner, name = repo.split("/", 1)
        api_path = (
            f"/repos/{urllib.parse.quote(owner)}/"
            f"{urllib.parse.quote(name)}/pulls/{number}"
        )
        body, err = _github_request(
            "GET",
            api_path,
            accept="application/vnd.github.v3.diff",
        )
        if err is not None:
            return err
        if body is None:
            return "GitHub returned empty diff"
        if len(body) > GITHUB_DIFF_MAX_BYTES:
            truncated = body[:GITHUB_DIFF_MAX_BYTES]
            try:
                text = truncated.decode("utf-8", errors="replace")
            except Exception:
                text = ""
            return text + "\\n[truncated: diff exceeds 256 KB cap]"
        try:
            return body.decode("utf-8", errors="replace")
        except Exception as exc:
            return f"GitHub diff decode error: {type(exc).__name__}: {exc}"

    def _list_issues(
        self,
        repo: str,
        state: str = "open",
        labels: Optional[str] = None,
        per_page: int = 30,
    ) -> str:
        if not repo or "/" not in repo:
            return "list_issues requires repo as 'owner/name'"
        owner, name = repo.split("/", 1)
        api_path = (
            f"/repos/{urllib.parse.quote(owner)}/"
            f"{urllib.parse.quote(name)}/issues"
        )
        query = {
            "state": state or "open",
            "per_page": min(max(int(per_page or 30), 1), 100),
        }
        if labels:
            query["labels"] = labels
        body, err = _github_request("GET", api_path, query=query)
        if err is not None:
            return err
        parsed, parse_err = _parse_json(body or b"")
        if parse_err is not None:
            return parse_err
        if not isinstance(parsed, list):
            return "GitHub returned unexpected payload for list_issues"
        # GitHub's /issues endpoint includes PRs as pseudo-issues; strip those.
        issues_only = [
            item for item in parsed
            if isinstance(item, dict) and "pull_request" not in item
        ]
        return json.dumps([_project_issue(i) for i in issues_only])

    def _run(
        self,
        method: str,
        repo: Optional[str] = None,
        owner: Optional[str] = None,
        path: Optional[str] = None,
        ref: Optional[str] = None,
        number: Optional[int] = None,
        state: Optional[str] = "open",
        labels: Optional[str] = None,
        per_page: Optional[int] = 30,
    ) -> str:
        m = (method or "").strip().lower()
        try:
            if m == "list_repos":
                return self._list_repos(
                    owner=owner,
                    per_page=per_page if per_page is not None else 30,
                )
            if m == "get_file_contents":
                if not repo or not path:
                    return "get_file_contents requires repo and path arguments"
                return self._get_file_contents(repo=repo, path=path, ref=ref)
            if m == "get_pull_request":
                if not repo or number is None:
                    return "get_pull_request requires repo and number arguments"
                return self._get_pull_request(repo=repo, number=int(number))
            if m == "get_pr_diff":
                if not repo or number is None:
                    return "get_pr_diff requires repo and number arguments"
                return self._get_pr_diff(repo=repo, number=int(number))
            if m == "list_issues":
                if not repo:
                    return "list_issues requires repo argument"
                return self._list_issues(
                    repo=repo,
                    state=state or "open",
                    labels=labels,
                    per_page=per_page if per_page is not None else 30,
                )
            return (
                "Unsupported GitHub method. Use one of: list_repos, "
                "get_file_contents, get_pull_request, get_pr_diff, list_issues."
            )
        except Exception as exc:  # pragma: no cover - defensive
            return f"GitHub tool error: {type(exc).__name__}: {exc}"
`;

/**
 * Filename for the emitted tool module inside the run's materialized
 * project directory. Exposed as a helper so the bundler and any future
 * inspection code don't drift from the actual on-disk name.
 */
export function getGitHubToolFilename(): string {
  return 'github_tool.py';
}
