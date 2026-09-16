import asyncio
import importlib.util
import unittest
from mirrors import MirrorsClient

@unittest.skipUnless(importlib.util.find_spec("pydantic_ai"), "Install [pydantic] extra")
class PydanticTests(unittest.TestCase):
    def test_real_testmodel_can_execute_wrapped_tool(self):
        from pydantic_ai import Agent
        from pydantic_ai.capabilities import ProcessHistory
        from pydantic_ai.toolsets import FunctionToolset
        from pydantic_ai.models.test import TestModel
        from mirrors.pydantic_ai import MirrorsToolset, history_processor
        c=MirrorsClient("sdk-test", "test")
        async def passive(**kwargs):return {"blocked":False,"masked_tools":[]}
        c.aevaluate=passive
        def count_items():return 42
        tools=MirrorsToolset(FunctionToolset(tools=[count_items]),c)
        agent=Agent(TestModel(),toolsets=[tools],capabilities=[ProcessHistory(history_processor(c))])
        result=agent.run_sync("Count items")
        self.assertIn("42",str(result.output))
        self.assertEqual(c.trajectory[0]["tool"],"count_items")

    def test_history_processor_appends_without_changing_prior_messages(self):
        from mirrors.pydantic_ai import history_processor
        from pydantic_ai.messages import ModelRequest,UserPromptPart
        c=MirrorsClient("s","m")
        async def inject(**kwargs):return {"blocked":False,"injection":"Check the result"}
        c.aevaluate=inject
        prior=[ModelRequest(parts=[UserPromptPart(content="Original")])]
        result=asyncio.run(history_processor(c)(None,prior))
        self.assertIs(result[0],prior[0])
        self.assertEqual(len(prior),1)
        self.assertEqual(len(result),2)

@unittest.skipUnless(importlib.util.find_spec("langgraph"), "Install [langgraph] extra")
class LangGraphTests(unittest.TestCase):
    def test_real_graph_uses_scoped_tail_and_tool_mask(self):
        from langgraph.graph import StateGraph,START,END
        from langchain_core.messages import HumanMessage
        from typing import TypedDict
        from mirrors.langgraph import LangGraphAdapter
        c=MirrorsClient("graph-test","test")
        async def decision(**kwargs):return {"blocked":False,"masked_tools":["write"],"injection":"Read first"}
        c.aevaluate=decision
        adapter=LangGraphAdapter(c)
        class State(TypedDict):
            messages:list
            allowed_tools:list
        async def model_node(state):
            prepared=await adapter.prepare(state["messages"],["read","write"])
            return {"messages":prepared["messages"],"allowed_tools":prepared["allowed_tools"]}
        graph=StateGraph(State);graph.add_node("model",model_node);graph.add_edge(START,"model");graph.add_edge("model",END)
        prior=[HumanMessage(content="Original")]
        result=asyncio.run(graph.compile().ainvoke({"messages":prior,"allowed_tools":[]}))
        self.assertEqual(result["allowed_tools"],["read"])
        self.assertEqual(result["messages"][-1].content,"[Mirrors] Read first")
        self.assertEqual(len(prior),1)

    def test_blocked_tool_never_executes(self):
        from mirrors.langgraph import LangGraphAdapter,MirrorsBlocked
        c=MirrorsClient("s","m")
        async def block(**kwargs):return {"blocked":True,"human":"Review"}
        c.aevaluate=block
        called=[]
        async def execute(args):called.append(True)
        with self.assertRaises(MirrorsBlocked):asyncio.run(LangGraphAdapter(c).call("write",{},execute))
        self.assertFalse(called)

if __name__=='__main__':unittest.main()
