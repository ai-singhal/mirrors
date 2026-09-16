"""Pydantic AI wrapper and history processor; initialize per agent run."""
from pydantic_ai import RunContext
from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.exceptions import ModelRetry
from .client import MirrorsClient

class MirrorsToolset(WrapperToolset):
    def __init__(self, wrapped, client: MirrorsClient):
        super().__init__(wrapped)
        self.mirrors = client

    async def get_tools(self, ctx: RunContext):
        tools = await super().get_tools(ctx)
        d = await self.mirrors.aevaluate(tools=list(tools), capabilities=["mask_tools"])
        return {k: v for k, v in tools.items() if k not in d.get("masked_tools", [])}

    async def call_tool(self, name, tool_args, ctx, tool):
        d = await self.mirrors.aevaluate(phase="tool", proposed=dict(tool=name, args=tool_args, status="unknown"), capabilities=["block", "human"])
        if d.get("blocked"):
            raise ModelRetry(d.get("human") or "Mirrors blocked this call; inspect the previous result before retrying.")
        try:
            result = await super().call_tool(name, tool_args, ctx, tool)
            self.mirrors.observe(name, tool_args)
            return result
        except Exception as exc:
            self.mirrors.observe(name, tool_args, "error", str(exc))
            raise

def history_processor(client: MirrorsClient):
    async def process(ctx: RunContext, messages):
        d = await client.aevaluate(capabilities=["inject"])
        if d.get("injection"):
            return [*messages, ModelRequest(parts=[UserPromptPart(content="[Mirrors] " + d["injection"])])]
        return messages
    return process
