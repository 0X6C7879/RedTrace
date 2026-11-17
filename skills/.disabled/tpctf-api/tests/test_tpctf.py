"""Offline mock tests; these tests NEVER call the CTFy website."""
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

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return json.dumps(self.payload).encode()


class TPCTFCLITest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
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
            {"id": "human", "title": "人机协同赛道", "is_registered": True},
            {"id": "agent", "title": "TPCTF 智能体团队赛道", "is_registered": True}
        ]}
        with patch.object(cli.API, "call", return_value=data):
            self.assertEqual(cli.API().competition(), "agent")

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
            self.assertEqual([x["id"] for x in r["items"]], ["b"])

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
