"""AI 정규화 경로 테스트 — 실제 모델 대신 모델이 돌려줄 법한 JSON 을 넣어 확인한다.
(요구사항/견적을 AI 로 정제 → 원문 대조 → 규칙과 비교 → Python 이 계산·판정)"""
import io, unittest, urllib.error
from unittest.mock import patch

from fastapi.testclient import TestClient

from . import ai_normalize as A
from .app import app

ENV = {"OPENAI_API_KEY": "sk-test-1234567890abcdef", "SRV_AI_ENABLED": ""}
ECR = "\n".join([
    "ECR-003", "미들웨어서버 H/W", "• 형태 : Rack Type", "• CPU : Intel Xeon 6 6505P 2.2GHz 이상 (12Core / 24Thread 이상)",
    "• Memory : 64GB 이상", "• Disk : Enterprise SSD 480GB RAID1", "• NIC : 10Gbps Dual Port × 2 ", "이상",
    "• HBA : 32Gbps Dual Port × 2 이상", "• OS : Red Hat Enterprise Linux Standard", "• RAID Controller 지원",
    "• 이중전원(Redundant Power) 지원", "• 미들웨어(TP Monitor) 운영을 위한 서버로 충분한 처리성능을 제공하여야 ",
    "  하며, 향후 시스템 확장 및 서비스 증가에도 안정적인 운영이 가능하여야 한다.",
])


def req(lines, category, **kw):
    return {"lines": lines, "category": category, "operator": kw.pop("operator", ">="), **kw}


def ecr_result(**override):
    reqs = [
        req([3], "rack", operator="=", required=True),
        req([4], "cpu_cores", min_cores=12, core_scope="per_cpu"),
        req([5], "memory", min_capacity_gb=64),
        req([6], "disk", min_size_gb=480), req([6], "raid", operator="=", raid_level="RAID1"),
        req([7, 8], "nic", speed_gbps=10, ports_per_card=2, card_quantity=2),
        req([9], "fc", speed_gbps=32, ports_per_card=2, card_quantity=2),
        req([11], "raid_controller", required=True), req([12], "psu", required=True),
        req([13, 14], "other", text="충분한 처리성능 · 확장성"),
    ]
    reqs = override.get("reqs", reqs)
    return {"document_type": "requirement", "server_groups": [{"name": "미들웨어서버", "quantity": None, "requirements": reqs}],
            "common_requirements": [], "ignored_lines": [{"line": 1, "reason": "요구 번호"}, {"line": 2, "reason": "제목"}, {"line": 10, "reason": "OS"}]}


def post(text, kind, result, **extra):
    with patch.dict("os.environ", ENV, clear=False), patch.object(A, "normalize", return_value=result):
        return TestClient(app).post("/api/paste", json={"text": text, "kind": kind, "ai": True, **extra}).json()


class RequirementAITests(unittest.TestCase):
    def test_ai_result_is_used_and_totals_are_computed_in_python(self):
        res = post(ECR, "requirement", ecr_result())
        sv = res["server"]
        self.assertTrue(res["ai"]["used"])
        got = {(r["key"], r["value"]) for r in sv["requirements"]}
        for item in [("cpu_cores", 12), ("memory_gb", 64.0), ("disk_size_gb", 480.0), ("raid_level", "RAID1"),
                     ("nic_speed_gb", 10.0), ("nic_ports", 4), ("fc_speed_gb", 32.0), ("fc_ports", 4),
                     ("rack_mount", True), ("raid_controller", True), ("dual_psu", True)]:
            self.assertIn(item, got)                         # 2포트 × 2장 = 4포트 는 Python 이 계산
        self.assertEqual(res["ai"]["conflicts"], [])         # 규칙 파서와 같은 해석 → 충돌 없음
        self.assertNotIn("warn", [l["status"] for l in sv["lines"]])
        self.assertTrue(any(r["key"] == "manual" for r in sv["requirements"]))   # 정량 불가 문장은 수기 검토로 남김

    def test_hallucinated_number_is_flagged_not_trusted(self):
        wrong = [req([5], "memory", min_capacity_gb=128)]            # 원문은 64GB
        res = post(ECR, "requirement", ecr_result(reqs=wrong))
        mem = next(r for r in res["server"]["requirements"] if r["key"] == "memory_gb")
        self.assertEqual(mem["status"], "review")                    # 자동 판정에 쓰지 않는다
        conflict = next(c for c in res["ai"]["conflicts"] if c["line"] == 4)
        self.assertTrue(conflict["unverified"] or conflict["kind"] == "diff")
        self.assertTrue(conflict["can_use_rule"])

    def test_user_can_pick_rule_value_for_a_conflicting_line(self):
        wrong = [req([5], "memory", min_capacity_gb=128)]
        res = post(ECR, "requirement", ecr_result(reqs=wrong), rule_lines=[4])
        mems = [r for r in res["server"]["requirements"] if r["key"] == "memory_gb"]
        self.assertEqual([(m["value"], m["how"]) for m in mems], [(64.0, "rule")])
        self.assertEqual(next(c for c in res["ai"]["conflicts"] if c["line"] == 4)["using"], "rule")

    def test_model_number_is_not_a_socket_count_and_multiple_groups_split(self):
        text = "공통: CPU 2소켓\n[DB 서버] 2대\n메모리 512GB 이상\n[APP 서버] 6대\n메모리 128GB"
        result = {"document_type": "requirement", "common_requirements": [req([1], "cpu_sockets", min_count=2)],
                  "server_groups": [{"name": "DB 서버 2대", "quantity": 2, "requirements": [req([3], "memory", min_capacity_gb=512)]},
                                    {"name": "APP 서버 6대", "quantity": 6, "requirements": [req([5], "memory", min_capacity_gb=128)]}],
                  "ignored_lines": []}
        res = post(text, "requirement", result)
        self.assertEqual([g["name"] for g in res["split"]], ["DB 서버", "APP 서버"])
        for group in res["split"]:
            self.assertIn("cpu_sockets", [r["key"] for r in group["requirements"]])   # 공통 요구는 모든 서버에
        self.assertEqual(res["split"][0]["quantity"], 2)


class QuoteAITests(unittest.TestCase):
    TEXT = "\n".join(["HW 서버\tRX2540M8\tPY RX2540 M8 8x 2.5'\t1", "\t\t64GB (1x64GB) 2Rx4 DDR5-6400 R ECC\t4",
                      "\t\tPLAN EP P210P 2x10Gb SFP+ FH\t2", "\t\tCable Kit\t1"])

    @staticmethod
    def comp(line, category, name, **kw):
        return {"line": line, "category": category, "name": name, **kw}

    def result(self, **mem_override):
        mem = {"unit_capacity_gb": 64, "quantity": 4, **mem_override}
        return {"document_type": "quotation", "ignored_lines": [], "server_groups": [{"name": "개발 서버", "quantity": 1, "components": [
            self.comp(1, "base", "PY RX2540 M8 8x 2.5'", quantity=1),
            self.comp(2, "memory", "64GB (1x64GB) 2Rx4 DDR5-6400 R ECC", **mem),
            self.comp(3, "nic", "PLAN EP P210P 2x10Gb SFP+ FH", model="P210P", speed_gbps=10, ports_per_card=2, quantity=2, height="FH"),
            self.comp(4, "accessory", "Cable Kit", quantity=1)]}]}

    def test_model_name_vs_ports_and_totals(self):
        res = post(self.TEXT, "quote", self.result())
        sv = res["server"]
        p = sv["proposed"]
        self.assertEqual(p["memory"]["total_gb"], 256)                                  # 64 × 4 (Python)
        nic = p["nic"][0]
        self.assertEqual((nic["qty"], nic["ports"], nic["speed_gb"]), (2, 2, 10))      # P210P 는 모델명, 2x10Gb → 2포트×10Gb
        self.assertEqual(nic["qty"] * nic["ports"], 4)                                  # 총 4포트
        self.assertEqual([l["status"] for l in sv["lines"]], ["part", "part", "part", "skip"])
        self.assertEqual(res["ai"]["conflicts"], [])

    def test_wrong_quantity_is_flagged_and_rule_can_replace_it(self):
        res = post(self.TEXT, "quote", self.result(quantity=8))                          # 원문은 4
        conflict = next(c for c in res["ai"]["conflicts"] if "64GB" in c["text"])
        self.assertTrue(conflict["unverified"] or conflict["kind"] == "diff")
        res = post(self.TEXT, "quote", self.result(quantity=8), rule_lines=[conflict["line"]])
        self.assertEqual(res["server"]["proposed"]["memory"]["total_gb"], 256)


class FallbackTests(unittest.TestCase):
    def test_ai_failure_keeps_rule_result_with_notice(self):
        with patch.dict("os.environ", ENV, clear=False), patch.object(A, "normalize", side_effect=A.AIError("x", "OpenAI API 크레딧이 없습니다")):
            res = TestClient(app).post("/api/paste", json={"text": "메모리 512GB 이상", "kind": "requirement", "ai": True}).json()
        self.assertFalse(res["ai"]["used"])
        self.assertIn("크레딧", res["ai"]["notice"])
        self.assertEqual([r["key"] for r in res["server"]["requirements"]], ["memory_gb"])

    def test_no_key_or_toggle_off_uses_rules(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "", "SRV_AI_ENABLED": ""}, clear=False):
            res = TestClient(app).post("/api/paste", json={"text": "메모리 512GB 이상", "kind": "requirement", "ai": True}).json()
            self.assertIn("키", res["ai"]["notice"])
            off = TestClient(app).post("/api/paste", json={"text": "메모리 512GB 이상", "kind": "requirement", "ai": False}).json()
        self.assertIsNone(off["ai"]["notice"])

    def test_http_errors_become_readable_notices(self):
        for body, words in ((b'{"error":{"code":"insufficient_quota","message":"quota"}}', "Billing"),
                            (b'{"error":{"code":"rate_limit_exceeded"}}', "잠시"), (b"", "HTTP 429")):
            boom = urllib.error.HTTPError("u", 429, "x", {}, io.BytesIO(body))
            with patch.dict("os.environ", ENV, clear=False), patch("urllib.request.urlopen", side_effect=boom):
                with self.assertRaises(A.AIError) as caught:
                    A.normalize("requirement", ["메모리 512GB 이상"])
            self.assertIn(words, caught.exception.user_message)

    def test_redact_masks_credentials_but_keeps_specs(self):
        out = A.redact("관리 ID admin PW Abcd1234!x 10.1.2.3 64GB DDR5 S26361-F4610-E204")
        self.assertNotIn("Abcd1234!x", out)
        self.assertNotIn("10.1.2.3", out)
        self.assertIn("64GB DDR5 S26361-F4610-E204", out)


if __name__ == "__main__":
    unittest.main()
