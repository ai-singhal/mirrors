import asyncio
import unittest
from mirrors import MirrorsClient
from mirrors.hermes import HermesPlugin

class BridgeTests(unittest.TestCase):
    def test_offline_is_passive(self):
        c=MirrorsClient("s", "m", url="http://127.0.0.1:1", timeout=.01)
        self.assertFalse(c.evaluate()["blocked"])
        self.assertFalse(asyncio.run(c.aevaluate())["blocked"])

    def test_observations_do_not_mutate_arguments(self):
        c=MirrorsClient("s","m");args={"id":"a"};c.observe("write",args,"error","bad");args["id"]="b"
        self.assertEqual(c.trajectory[0]["args"]["id"],"a")

    def test_malformed_server_response_fails_open(self):
        c=MirrorsClient("s","m");c._post=lambda *args: {"error":"bad response"}
        self.assertFalse(c.evaluate()["blocked"])

    def test_hermes_registers_current_hook_contracts(self):
        hooks={}
        class Context:
            def register_hook(self,name,fn):hooks[name]=fn
        p=HermesPlugin();p.register(Context())
        self.assertEqual(set(hooks),{"pre_llm_call","pre_tool_call","post_tool_call","post_llm_call"})
        c=p.client(session_id="s",model="m")
        c.evaluate=lambda **kw: {"blocked":True,"human":"Review needed"}
        self.assertEqual(hooks["pre_tool_call"]("write",{},session_id="s"),{"action":"block","message":"Review needed"})
        hooks["post_tool_call"]("write",{},status="error",error_message="bad",session_id="s")
        self.assertEqual(c.trajectory[0]["status"],"error")

if __name__ == '__main__':unittest.main()
