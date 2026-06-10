"""HTTP client for the Jarvis agent runtime.

Stdlib-only (``urllib``) so the package has zero dependencies. Namespaces
mirror the product design: ``chat`` (completions + conversations), ``work``
(projects + requirements kanban), ``memory`` (long-term memory rows). The
wire surface this client targets is the curated OpenAPI document served at
``GET /v1/openapi.json``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List, Optional
from urllib import error, parse, request

__all__ = ["JarvisClient", "JarvisApiError"]


class JarvisApiError(Exception):
    """Non-2xx reply from the server."""

    def __init__(self, status: int, body: Any):
        super().__init__(f"Jarvis API error: HTTP {status}")
        self.status = status
        self.body = body


class JarvisClient:
    """Synchronous client. One instance per server."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:7001",
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 600.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.headers = dict(headers or {})
        self.timeout = timeout
        self.chat = _Chat(self)
        self.conversations = _Conversations(self)
        self.work = _Work(self)
        self.memory = _Memory(self)

    # ---- meta -----------------------------------------------------------

    def health(self) -> Any:
        return self._request("GET", "/health")

    def version(self) -> Dict[str, str]:
        return self._request("GET", "/v1/version")

    def server_info(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/server/info")

    def openapi(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/openapi.json")

    # ---- transport ------------------------------------------------------

    def _url(self, path: str, query: Optional[Dict[str, Any]] = None) -> str:
        url = self.base_url + path
        if query:
            pairs = {k: str(v) for k, v in query.items() if v is not None}
            if pairs:
                url += "?" + parse.urlencode(pairs)
        return url

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Dict[str, Any]] = None,
    ) -> Any:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = dict(self.headers)
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(
            self._url(path, query), data=data, headers=headers, method=method
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed: Any = json.loads(raw) if raw else None
            except ValueError:
                parsed = raw
            raise JarvisApiError(e.code, parsed) from None
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return raw

    def _sse(self, path: str, body: Any) -> Iterator[Dict[str, Any]]:
        """POST ``body``, yield one parsed JSON object per SSE ``data:`` frame."""
        data = json.dumps(body).encode("utf-8")
        headers = dict(self.headers)
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "text/event-stream"
        req = request.Request(self._url(path), data=data, headers=headers, method="POST")
        try:
            resp = request.urlopen(req, timeout=self.timeout)
        except error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed: Any = json.loads(raw) if raw else None
            except ValueError:
                parsed = raw
            raise JarvisApiError(e.code, parsed) from None
        with resp:
            data_lines: List[str] = []
            for raw_line in resp:
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                    continue
                if line == "" and data_lines:
                    payload = "\n".join(data_lines)
                    data_lines = []
                    if payload and payload != "[DONE]":
                        try:
                            yield json.loads(payload)
                        except ValueError:
                            pass  # skip malformed frames, keep the stream alive
            if data_lines:
                payload = "\n".join(data_lines)
                if payload and payload != "[DONE]":
                    try:
                        yield json.loads(payload)
                    except ValueError:
                        pass


class _Chat:
    def __init__(self, c: JarvisClient):
        self._c = c

    def complete(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Blocking agent run. Returns ``{message, iterations, history}``."""
        body: Dict[str, Any] = {"messages": messages}
        if model:
            body["model"] = model
        if provider:
            body["provider"] = provider
        return self._c._request("POST", "/v1/chat/completions", body)

    def stream(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Streaming agent run; yields one ``AgentEvent`` dict per frame."""
        body: Dict[str, Any] = {"messages": messages}
        if model:
            body["model"] = model
        if provider:
            body["provider"] = provider
        return self._c._sse("/v1/chat/completions/stream", body)


class _Conversations:
    def __init__(self, c: JarvisClient):
        self._c = c

    def create(
        self,
        system: Optional[str] = None,
        id: Optional[str] = None,
        project: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = {k: v for k, v in {"system": system, "id": id, "project": project}.items() if v}
        return self._c._request("POST", "/v1/conversations", body)

    def list(self, limit: Optional[int] = None) -> Any:
        return self._c._request("GET", "/v1/conversations", query={"limit": limit})

    def get(self, conversation_id: str) -> Any:
        return self._c._request("GET", f"/v1/conversations/{parse.quote(conversation_id)}")

    def delete(self, conversation_id: str) -> Any:
        return self._c._request("DELETE", f"/v1/conversations/{parse.quote(conversation_id)}")

    def post_message(
        self,
        conversation_id: str,
        content: str,
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"content": content}
        if model:
            body["model"] = model
        if provider:
            body["provider"] = provider
        return self._c._request(
            "POST", f"/v1/conversations/{parse.quote(conversation_id)}/messages", body
        )

    def stream_message(
        self,
        conversation_id: str,
        content: str,
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        body: Dict[str, Any] = {"content": content}
        if model:
            body["model"] = model
        if provider:
            body["provider"] = provider
        return self._c._sse(
            f"/v1/conversations/{parse.quote(conversation_id)}/messages/stream", body
        )


class _Projects:
    def __init__(self, c: JarvisClient):
        self._c = c

    def list(self) -> Any:
        return self._c._request("GET", "/v1/projects")

    def create(self, name: str, **fields: Any) -> Any:
        return self._c._request("POST", "/v1/projects", {"name": name, **fields})

    def get(self, id_or_slug: str) -> Any:
        return self._c._request("GET", f"/v1/projects/{parse.quote(id_or_slug)}")


class _Requirements:
    def __init__(self, c: JarvisClient):
        self._c = c

    def list(self, project_id: str, triage_state: Optional[str] = None) -> Any:
        return self._c._request(
            "GET",
            f"/v1/projects/{parse.quote(project_id)}/requirements",
            query={"triage_state": triage_state},
        )

    def create(self, project_id: str, title: str, **fields: Any) -> Any:
        return self._c._request(
            "POST",
            f"/v1/projects/{parse.quote(project_id)}/requirements",
            {"title": title, **fields},
        )

    def get(self, requirement_id: str) -> Any:
        return self._c._request("GET", f"/v1/requirements/{parse.quote(requirement_id)}")

    def update(self, requirement_id: str, **patch: Any) -> Any:
        return self._c._request(
            "PATCH", f"/v1/requirements/{parse.quote(requirement_id)}", patch
        )

    def delete(self, requirement_id: str) -> Any:
        return self._c._request("DELETE", f"/v1/requirements/{parse.quote(requirement_id)}")

    def approve(self, requirement_id: str) -> Any:
        return self._c._request(
            "POST", f"/v1/requirements/{parse.quote(requirement_id)}/approve"
        )

    def reject(self, requirement_id: str, reason: str) -> Any:
        return self._c._request(
            "POST",
            f"/v1/requirements/{parse.quote(requirement_id)}/reject",
            {"reason": reason},
        )

    def runs(self, requirement_id: str) -> Any:
        return self._c._request("GET", f"/v1/requirements/{parse.quote(requirement_id)}/runs")

    def start_run(self, requirement_id: str) -> Any:
        return self._c._request(
            "POST", f"/v1/requirements/{parse.quote(requirement_id)}/runs"
        )


class _Work:
    def __init__(self, c: JarvisClient):
        self.projects = _Projects(c)
        self.requirements = _Requirements(c)


class _Memory:
    def __init__(self, c: JarvisClient):
        self._c = c

    def list(self, scope: Optional[str] = None, limit: Optional[int] = None) -> Any:
        return self._c._request(
            "GET", "/v1/memories", query={"scope": scope, "limit": limit}
        )

    def create(self, item: Dict[str, Any]) -> Any:
        return self._c._request("POST", "/v1/memories", item)

    def patch(self, memory_id: str, **patch: Any) -> Any:
        return self._c._request("PATCH", f"/v1/memories/{parse.quote(memory_id)}", patch)

    def delete(self, memory_id: str) -> Any:
        return self._c._request("DELETE", f"/v1/memories/{parse.quote(memory_id)}")
