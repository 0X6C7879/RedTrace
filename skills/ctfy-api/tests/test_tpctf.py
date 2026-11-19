"""Offline contract regressions; these tests NEVER call the CTFy website."""
import argparse
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

MODULE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "tpctf.py"
spec = importlib.util.spec_from_file_location("tpctf_cli", MODULE)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return self.payload if isinstance(self.payload, bytes) else json.dumps(self.payload).encode()


class TPCTFCLITest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "CTFY_TOKEN": "",
            "CTFY_PLAY_TOKEN": "pf_test_secret",
            "CTFY_AUTHOR_TOKEN": "pf_author_secret",
            "CTFY_BASE_URL": "https://ctfy.tsinghua.edu.cn/api/v1",
            "CTFY_COMPETITION_ID": "contest-1",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def parse(self, command):
        return cli.parser().parse_args(command.split())

    def test_token_not_present_in_doctor_output(self):
        x = cli.run(self.parse("doctor"))
        self.assertTrue(x["play_token_configured"])
        self.assertNotIn("pf_test_secret", json.dumps(x))

    def test_api_auth_header_and_exact_path(self):
        def fake_open(req, timeout):
            self.assertEqual(req.full_url, "https://ctfy.tsinghua.edu.cn/api/v1/competitions")
            self.assertEqual(req.get_header("Authorization"), "Bearer pf_test_secret")
            return FakeResponse({"items": []})
        with patch.object(cli.urllib.request, "urlopen", side_effect=fake_open):
            self.assertEqual(cli.API().call("GET", "competitions"), {"items": []})

    def test_auto_competition_detect(self):
        os.environ.pop("CTFY_COMPETITION_ID")
        data = {"items": [
            {"id": "human", "title": "人机协同赛道", "is_registered": False},
            {"id": "agent", "title": "TPCTF 智能体团队赛道", "is_registered": True}
        ]}
        with patch.object(cli.API, "call", return_value=data):
            self.assertEqual(cli.API().competition(), "agent")

    def test_generic_platform_competition(self):
        os.environ.pop("CTFY_COMPETITION_ID")
        data = {"items": [
            {"id": "old", "title": "TPCTF Agent", "is_registered": True, "phase": "past", "play_open": False},
            {"id": "suite", "title": "CYBENCH", "is_registered": True, "phase": "running", "play_open": True},
        ]}
        with patch.object(cli.API, "call", return_value=data):
            self.assertEqual(cli.API().competition(), "suite")

    def test_multiple_open_competitions_require_explicit_id(self):
        os.environ.pop("CTFY_COMPETITION_ID")
        data = {"items": [
            {"id": "event", "title": "TPCTF Agent", "is_registered": True, "phase": "running", "play_open": True},
            {"id": "suite", "title": "CYBENCH", "is_registered": True, "phase": "running", "play_open": True},
        ]}
        with patch.object(cli.API, "call", return_value=data):
            with self.assertRaises(cli.PlatformError) as cm:
                cli.API().competition()
            self.assertEqual(cm.exception.code, "competition_ambiguous")

    def test_platform_token_fallback_and_role_token_precedence(self):
        os.environ["CTFY_TOKEN"] = "pf_platform_secret"
        self.assertEqual(cli.require_token("play"), "pf_test_secret")
        os.environ.pop("CTFY_PLAY_TOKEN")
        self.assertEqual(cli.require_token("play"), "pf_platform_secret")
        self.assertTrue(cli.run(self.parse("doctor"))["play_token_configured"])

    def test_failed_online_doctor_is_not_ok(self):
        with patch.object(cli.API, "call", side_effect=cli.PlatformError("http_401", "Rejected", 401)):
            result = cli.run(self.parse("doctor --online"))
        self.assertFalse(result["ok"])
        self.assertFalse(result["platform_api_reachable"])

    def test_failed_doctor_exits_nonzero(self):
        with patch.object(cli, "run", return_value={"ok": False}), patch.object(cli.sys, "argv", ["ctfy", "doctor"]), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cli.main(), 1)

    def test_mcp_initializes_and_parses_sse(self):
        requests = []
        def fake_open(req, timeout):
            payload = json.loads(req.data)
            requests.append(payload)
            self.assertEqual(req.full_url, "https://ctfy.tsinghua.edu.cn/api/v1/mcp/")
            self.assertIn("text/event-stream", req.get_header("Accept"))
            if payload["method"] == "initialize":
                response = FakeResponse({"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-03-26"}})
                response.headers["Mcp-Session-Id"] = "session-1"
                return response
            self.assertEqual(req.get_header("Mcp-session-id"), "session-1")
            self.assertEqual(req.get_header("Mcp-protocol-version"), "2025-03-26")
            if payload["method"] == "notifications/initialized":
                self.assertNotIn("id", payload)
                return FakeResponse(b"")
            return FakeResponse(b'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_competitions"}]}}\r\n\r\n')
        with patch.object(cli.urllib.request, "urlopen", side_effect=fake_open):
            result = cli.run(self.parse("mcp tools"))
        self.assertEqual(result["tools"][0]["name"], "list_competitions")
        self.assertEqual([r["method"] for r in requests], ["initialize", "notifications/initialized", "tools/list"])

    def test_mcp_tool_arguments_from_stdin(self):
        data = {"competition_id": "suite"}
        with patch.object(cli.API, "mcp", return_value={"structuredContent": {"id": "suite"}}) as rpc, patch("sys.stdin", io.StringIO(json.dumps(data))):
            cli.run(self.parse("mcp call get_competition --arguments-stdin"))
        rpc.assert_called_once_with("tools/call", {"name": "get_competition", "arguments": data})

    def test_mcp_rejects_non_object_arguments_before_network(self):
        with patch.object(cli.urllib.request, "urlopen") as network:
            with self.assertRaises(cli.PlatformError) as cm:
                cli.run(self.parse("mcp call list_competitions --arguments []"))
        self.assertEqual(cm.exception.code, "invalid_arguments")
        network.assert_not_called()

    def test_mcp_sse_skips_progress_and_comments(self):
        response = FakeResponse(b': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"tools":[]}}\n\n')
        with patch.object(cli.urllib.request, "urlopen", return_value=response):
            self.assertEqual(cli.API().call("POST", "mcp/", body={"id": 2}, rpc=True), {"tools": []})

    def test_mcp_protocol_and_tool_errors_are_failures(self):
        for response, code in [
            ({"error": {"code": -32602, "message": "Invalid params"}}, "mcp_error"),
            ({"result": {"isError": True, "content": [{"type": "text", "text": "permission denied"}]}}, "mcp_tool_error"),
        ]:
            with patch.object(cli.urllib.request, "urlopen", return_value=FakeResponse(response)):
                with self.assertRaises(cli.PlatformError) as cm:
                    cli.API().call("POST", "mcp/", body={"id": 2}, rpc=True)
                self.assertEqual(cm.exception.code, code)

    def test_start_and_wait(self):
        replies = [
            {"id": "i-12", "status": "starting"},
            {"id": "i-12", "status": "ready", "entry_urls": ["https://instance.example"]},
        ]
        with patch.object(cli.API, "call", side_effect=replies) as api:
            result = cli.run(self.parse("start challenge-1 --wait --interval 0"))
            self.assertEqual(result["status"], "ready")
            self.assertEqual(api.call_count, 2)

    def test_submissions_are_bound_to_instance_and_question(self):
        responses = [
            {"questions": [{"id": "q1", "unlocked": True, "answered_correctly": False, "attempts_remaining": 3}]},
            {"correct": True, "ranked": True, "challenge_fully_solved": False}
        ]
        with patch.object(cli.API, "call", side_effect=responses) as api:
            result = cli.run(self.parse("submit instance-1 --question q1 --answer flag123"))
            self.assertTrue(result["correct"])
            self.assertEqual(api.call_args.kwargs["body"], {"instance_id": "instance-1", "question_id": "q1", "answer": "flag123"})

    def test_submissions_refuse_locked_or_exhausted(self):
        for unlocked, attempts in [(False, 2), (True, 0)]:
            response = {"questions": [{"id": "q1", "unlocked": unlocked, "answered_correctly": False, "attempts_remaining": attempts}]}
            with patch.object(cli.API, "call", return_value=response) as api:
                with self.assertRaises(cli.PlatformError):
                    cli.run(self.parse("submit instance-1 --question q1 --answer guess"))
                self.assertEqual(api.call_count, 1)

    def test_challenge_filter(self):
        response = {"items": [
            {"id": "a", "my_team_fully_solved": True, "scoring": "scored"},
            {"id": "b", "my_team_fully_solved": False, "closed": False, "scoring": "scored"},
            {"id": "c", "my_team_fully_solved": False, "closed": True, "scoring": "scored"},
            {"id": "d", "my_team_fully_solved": False, "closed": False, "scoring": "practice"},
        ]}
        with patch.object(cli.API, "call", return_value=response):
            r = cli.run(self.parse("challenges --unsolved"))
            self.assertEqual([x["id"] for x in r["items"]], ["b", "d"])

    def test_vpn_config_permissions_and_state(self):
        with tempfile.TemporaryDirectory() as path:
            os.environ["CTFY_STATE_DIR"] = path
            self.addCleanup(lambda: os.environ.pop("CTFY_STATE_DIR", None))
            with patch.object(cli.API, "call", side_effect=[{"status": "ready", "vpn_endpoint": {"config_url": "https://ctfy.tsinghua.edu.cn/api/v1/instances/i-1/vpn-config"}}, b"[Interface]\nPrivateKey = dummy\n"]), patch.object(cli.shutil, "which", return_value="/usr/bin/wg-quick"), patch.object(cli, "tunnel_is_up", return_value=False), patch.object(cli.subprocess, "run", return_value=argparse.Namespace(returncode=0, stderr="")):
                x = cli.vpn_setup(cli.API(), "i-1")
                self.assertEqual(x["vpn"], "up")
                self.assertEqual((pathlib.Path(path) / "tpctf0.conf").stat().st_mode & 0o777, 0o600)
                self.assertEqual(cli.load_vpn_state()["instance_id"], "i-1")

    def test_missing_competition_unambiguous_error(self):
        os.environ.pop("CTFY_COMPETITION_ID")
        with patch.object(cli.API, "call", return_value={"items": []}):
            with self.assertRaises(cli.PlatformError) as cm:
                cli.API().competition()
            self.assertEqual(cm.exception.code, "competition_ambiguous")


if __name__ == "__main__":
    unittest.main()
