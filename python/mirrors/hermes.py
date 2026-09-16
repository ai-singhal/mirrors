"""Hermes plugin hooks. pre_llm_call is turn-scoped, not per provider attempt."""
from .client import MirrorsClient

class HermesPlugin:
    def __init__(self, url="http://127.0.0.1:7433"):
        self.url = url
        self.sessions = {}

    def client(self, session_id=None, model=None, **kwargs):
        if not session_id: return None
        if session_id not in self.sessions:
            if len(self.sessions) >= 1000: self.sessions.pop(next(iter(self.sessions)))
            self.sessions[session_id] = MirrorsClient(session_id, model or "unknown", self.url)
        client = self.sessions[session_id]
        if model: client.model = model
        return client

    def before_model(self, **kwargs):
        client = self.client(**kwargs)
        if client is None: return
        decision = client.evaluate(capabilities=["inject"])
        if decision.get("injection"): return {"context": decision["injection"]}

    def before_tool(self, tool_name, args, **kwargs):
        client = self.client(**kwargs)
        if client is None: return
        decision = client.evaluate(phase="tool", proposed=dict(tool=tool_name, args=args, status="unknown"), capabilities=["block", "human"])
        if decision.get("blocked"):
            reason = decision.get("human") or next((e["reason"] for e in decision.get("evaluations", []) if e.get("outcome") == "fire"), "Mirrors intervention")
            return {"action": "block", "message": reason}

    def after_tool(self, tool_name, args, status="success", error_message=None, **kwargs):
        client = self.client(**kwargs)
        if client: client.observe(tool_name, args, status if status in ["success", "error", "blocked"] else "unknown", error_message)

    def finish(self, session_id=None, **kwargs):
        client = self.sessions.pop(session_id, None)
        if client: client.finish()

    def register(self, ctx):
        ctx.register_hook("pre_llm_call", self.before_model)
        ctx.register_hook("pre_tool_call", self.before_tool)
        ctx.register_hook("post_tool_call", self.after_tool)
        ctx.register_hook("post_llm_call", self.finish)

def register(ctx):
    HermesPlugin().register(ctx)
