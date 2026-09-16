from __future__ import annotations
import asyncio
import json
import urllib.request
from copy import deepcopy
from typing import Any

class MirrorsClient:
    """Create one client per run. Explicitly finish the run to measure recurrence."""
    def __init__(self, session_id: str, model: str, url="http://127.0.0.1:7433", timeout=0.25, prompt_hash=None):
        self.session_id, self.model, self.url, self.timeout = session_id, model, url.rstrip("/"), timeout
        self.prompt_hash = prompt_hash
        self.trajectory: list[dict[str, Any]] = []
        self.step = 0
        self.capabilities = set()

    def context(self, phase="model", tools=None, proposed=None, capabilities=None):
        result = dict(session_id=self.session_id, model=self.model, step=self.step,
                      phase=phase, tools=tools or [], trajectory=deepcopy(self.trajectory[-1000:]), intent="")
        if proposed is not None: result["proposed"] = proposed
        if self.prompt_hash is not None: result["prompt_hash"] = self.prompt_hash
        if capabilities is not None: result["capabilities"] = capabilities
        return result

    def _post(self, endpoint, payload):
        req = urllib.request.Request(self.url + "/api/" + endpoint,
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            return json.load(response)

    def evaluate(self, **kwargs):
        try:
            self.capabilities.update(kwargs.get("capabilities") or [])
            result = self._post("evaluate", self.context(**kwargs))
            if not isinstance(result, dict) or not isinstance(result.get("blocked"), bool):
                raise ValueError("Invalid Mirrors response")
            return result
        except Exception as exc:
            return dict(blocked=False, masked_tools=[], evaluations=[], error=str(exc))

    async def aevaluate(self, **kwargs):
        return await asyncio.to_thread(self.evaluate, **kwargs)

    def observe(self, tool, args, status="success", error=None):
        self.trajectory.append(dict(tool=tool, args=deepcopy(args), status=status, **({"error": str(error)} if error else {})))
        self.trajectory = self.trajectory[-1000:]
        self.step += 1

    def finish(self, failures=None):
        try:
            return self._post("finish", {"context": self.context(capabilities=sorted(self.capabilities)), **({"failures": failures} if failures is not None else {})})
        except Exception:
            return None
