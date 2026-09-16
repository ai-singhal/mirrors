"""Composable helpers for a LangGraph model node and tool node.

The model node consumes prepare(). The tool node calls guard() and observe().
No mutation of the graph's system prompt or previous messages is performed.
"""
from langchain_core.messages import HumanMessage
from .client import MirrorsClient

class MirrorsBlocked(Exception):
    pass

class LangGraphAdapter:
    def __init__(self, client: MirrorsClient):
        self.client = client

    async def prepare(self, messages, tool_names, can_swap_model=False):
        capabilities = ["inject", "mask_tools", "force_tool"]
        if can_swap_model: capabilities.append("swap_model")
        d = await self.client.aevaluate(tools=tool_names, capabilities=capabilities)
        return {
            "messages": [*messages, HumanMessage(content="[Mirrors] " + d["injection"])] if d.get("injection") else messages,
            "allowed_tools": [t for t in tool_names if t not in d.get("masked_tools", [])],
            "forced_tool": d.get("forced_tool"), "model": d.get("model"),
        }

    async def guard(self, tool, args):
        d = await self.client.aevaluate(phase="tool", proposed=dict(tool=tool, args=args, status="unknown"), capabilities=["block", "human"])
        if d.get("blocked"): raise MirrorsBlocked(d.get("human") or "Mirrors blocked this tool call")

    async def call(self, tool, args, execute):
        await self.guard(tool, args)
        try:
            result = await execute(args)
            self.client.observe(tool, args)
            return result
        except Exception as exc:
            self.client.observe(tool, args, "error", str(exc))
            raise
