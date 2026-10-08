"""붙여넣기 분석·규칙 보강·작업 저장 테스트."""
import unittest

from fastapi.testclient import TestClient

import io, urllib.error
from unittest.mock import patch

from . import extract, paste as A
from .app import app


def keys(text):
    return [(r["key"], r["value"]) for r in extract.extract_requirements(text)]


class RuleTests(unittest.TestCase):
    def test_cores_disks_and_nic_with_fc_on_one_line(self):
        self.assertIn(("cpu_cores", 32), keys("CPU: 2소켓, 코어 32개 이상"))
        self.assertEqual(keys("SSD 1.92TB 4개 이상 RAID5"),
                         [("disk_size_gb", 1920.0), ("disk_count", 4), ("raid_level", "RAID5")])
        found = keys("10GbE 2포트 이상, FC 32Gb 2포트")
        for item in [("nic_speed_gb", 10.0), ("nic_ports", 2), ("fc_speed_gb", 32.0), ("fc_ports", 2)]:
            self.assertIn(item, found)

    def test_model_core_count_is_per_cpu_and_os_disk_is_boot(self):
        reqs = extract.extract_requirements("Xeon Gold 6430 32C 2.1GHz x 2")
        self.assertEqual([(r["key"], r["value"], r["note"]) for r in reqs if r["key"] == "cpu_cores"], [("cpu_cores", 32, "CPU당")])
        self.assertTrue(all(r["note"] == "Boot" for r in extract.extract_requirements("OS용 SSD 480GB 2개 RAID1")))

    def test_speed_specific_ports(self):
        ports = [(r["value"], r.get("at_speed")) for r in extract.extract_requirements("1GbE 4포트 이상 / 10GbE SFP+ 2포트") if r["key"] == "nic_ports"]
        self.assertEqual(ports, [(4, 1.0), (2, 10.0)])


class QuotePasteTests(unittest.TestCase):
    """품번 없이 긁어 온 GPU 서버 견적 (머리글 없음, 줄마다 칸 수가 다름)."""
    TEXT = "\n".join([
        "HW 서버\tRX2540M8\tPY RX2540 M8 16x 2.5' for Graphics\t1",
        "\t\tConfiguration Thermal Design 25°C\t1", "\t\tIntel Xeon 6520P 24C 2.4 GHz\t2", "\t\tCooler Kit 2nd CPU\t1",
        "\t\t64GB (1x64GB) 2Rx4 DDR5-6400 R ECC\t8", "\t\tGPU Fan Kit\t1", "\t\tNVIDIA H200 NVL\t1",
        "\t\tSSD SATA 6G 480GB MU 2.5' H-P\t2", "\t\tPRAID CP700i LP\t1", "\t\t16x 2.5 Single RAID Cable Kit\t1",
        "\t\tGPU power cable\t1", "\t\tModular PSU 2400W titanium hp\t2", "\t\tGFX/GPU Riser Left\t1",
    ])

    def test_uncoded_quote_is_read_as_quote_with_every_line_classified(self):
        client = TestClient(app)
        sv = client.post("/api/paste", json={"text": self.TEXT, "kind": "quote"}).json()["server"]
        self.assertEqual(sv["doc_role"], "quote")
        self.assertNotIn("warn", [l["status"] for l in sv["lines"]])
        self.assertNotIn("req", [l["status"] for l in sv["lines"]])  # 'Xeon 24C' 가 요구사항이 되면 안 됨
        p = sv["proposed"]
        self.assertEqual((p["cpu"]["count"], p["psu"]["watt"], len(p["gpu"])), (2, 2400, 1))
        # GPU Fan Kit · GPU power cable · RAID Cable Kit 은 부속품
        skipped = [l["text"] for l in sv["lines"] if l["status"] == "skip"]
        for word in ("GPU Fan Kit", "GPU power cable", "RAID Cable Kit"):
            self.assertTrue(any(word in text for text in skipped), word)

    def test_gpu_is_placed_in_a_double_width_slot(self):
        client = TestClient(app)
        sv = client.post("/api/paste", json={"text": self.TEXT, "kind": "quote"}).json()["server"]
        server = client.get("/api/servers").json()["servers"][0]
        base = {"cpu_model": server["cpu_options"][0], "cpu_count": 2, "memory": [], "backplane": server["backplanes"][0]["id"],
                "bays": {}, "raid": {"boot": "", "data": ""}, "boss": False, "psu_watt": 1400, "psu_count": 2, "risers": [], "slots": {}}
        res = client.post("/api/proposal/apply", json={"server_id": server["id"], "proposed": sv["proposed"], "base_config": base}).json()
        self.assertIn("gpu_h100", res["config"]["slots"].values())
        self.assertTrue(any("H200" in note and "대체" in note for note in res["notes"]))


class KindTests(unittest.TestCase):
    """칸이 정한다: 견적 칸의 'Xeon 24C' 는 요구사항이 되지 않고, 요구사항 칸의 표는 견적이 되지 않는다."""
    def test_kind_decides(self):
        client = TestClient(app)
        text = "Intel Xeon 6520P 24C 2.4 GHz\t2\n64GB DDR5 RDIMM\t8"
        req = client.post("/api/paste", json={"text": text, "kind": "requirement"}).json()["server"]
        self.assertEqual(req["doc_role"], "requirement")
        quote = client.post("/api/paste", json={"text": text, "kind": "quote"}).json()["server"]
        self.assertEqual(quote["doc_role"], "quote")
        self.assertEqual(quote["requirements"], [])

    def test_unreadable_quote_is_an_error_not_a_guess(self):
        res = TestClient(app).post("/api/paste", json={"text": "견적 아님", "kind": "quote"})
        self.assertEqual(res.status_code, 422)


class ValidateTests(unittest.TestCase):
    def test_cores_and_disks_are_checked(self):
        client = TestClient(app)
        server = client.get("/api/servers").json()["servers"][0]
        bp = next(b for b in server["backplanes"] if b["bays"] >= 4 and b["ff"] == "2.5")
        cfg = {"cpu_model": "Xeon Gold 6430", "cpu_count": 2, "memory": [{"size_gb": 64, "qty": 8}], "slots": {},
               "risers": [], "psu_count": 2, "psu_watt": 1400, "backplane": bp["id"], "raid": {"data": "", "boot": ""}, "boss": False,
               "bays": {str(i): {"drive": "ssd1920_sas", "role": "data"} for i in range(2)}}
        reqs = extract.extract_requirements("코어 64개 이상\nSSD 1.92TB 4개 이상")
        rows = client.post("/api/validate", json={"server_id": server["id"], "config": cfg, "requirements": reqs}).json()["requirements"]
        by_id = {r["id"]: r["key"] for r in reqs}
        status = {by_id[r["id"]]: r["status"] for r in rows}
        self.assertEqual(status["cpu_cores"], "충족")      # 32C × 2
        self.assertEqual(status["disk_size_gb"], "충족")
        self.assertEqual(status["disk_count"], "미충족")   # 2개뿐


class SpecSheetTests(unittest.TestCase):
    """제안요청서 형식 (요구 번호 · 글머리 · 줄바꿈된 '이상' · 둘째 줄로 넘어간 문장)."""
    TEXT = "\n".join([
        "ECR-003", "미들웨어서버 H/W", "• 형태 : Rack Type",
        "• CPU : Intel Xeon 6 6505P 2.2GHz 이상 (12Core / 24Thread 이상)", "• Memory : 64GB 이상",
        "• Disk : Enterprise SSD 480GB RAID1", "• NIC : 10Gbps Dual Port × 2 ", "이상",
        "• HBA : 32Gbps Dual Port × 2 이상", "• OS : Red Hat Enterprise Linux Standard", "• RAID Controller 지원",
        "• 이중전원(Redundant Power) 지원",
        "• 미들웨어(TP Monitor) 운영을 위한 서버로 충분한 처리성능을 제공하여야 ",
        "  하며, 향후 시스템 확장 및 서비스 증가에도 안정적인 운영이 가능하여야 한다.",
    ])

    def test_every_line_read_and_model_number_is_not_a_socket_count(self):
        sv = TestClient(app).post("/api/paste", json={"text": self.TEXT, "kind": "requirement"}).json()["server"]
        self.assertNotIn("warn", [l["status"] for l in sv["lines"]])
        got = {(r["key"], r["value"]) for r in sv["requirements"]}
        for item in [("cpu_cores", 12), ("memory_gb", 64.0), ("disk_size_gb", 480.0), ("raid_level", "RAID1"),
                     ("nic_speed_gb", 10.0), ("nic_ports", 4), ("fc_speed_gb", 32.0), ("fc_ports", 4),
                     ("rack_mount", True), ("raid_controller", True), ("dual_psu", True)]:
            self.assertIn(item, got)
        self.assertNotIn("cpu_sockets", [k for k, _ in got])  # '6505P' 의 5P 는 소켓 수가 아님
        os_line = next(l for l in sv["lines"] if "Red Hat" in l["text"])
        self.assertEqual(os_line["status"], "req")   # OS 는 지우지 않고 요구사항(확인 필요)으로 남긴다
        os_req = next(r for r in sv["requirements"] if r["key"] == "os_spec")
        self.assertEqual(os_req["status"], "review")
        self.assertIn("RHEL", str(os_req["value"]))


class RaidTests(unittest.TestCase):
    def test_higher_raid_satisfies(self):
        from .validate import _raid_covers
        self.assertTrue(_raid_covers("RAID6", "RAID5"))
        self.assertTrue(_raid_covers("RAID10", "RAID5"))
        self.assertTrue(_raid_covers("RAID5", "RAID1"))
        self.assertFalse(_raid_covers("RAID5", "RAID6"))
        self.assertFalse(_raid_covers("RAID0", "RAID1"))


class PasteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_every_line_gets_a_status(self):
        text = "서버 요구사항\nCPU: 2소켓, 코어 32개 이상\n관리 포트는 원격 KVM 지원\n메모리 512GB 이상"
        res = self.client.post("/api/paste", json={"text": text}).json()
        self.assertEqual([l["status"] for l in res["server"]["lines"]], ["head", "req", "warn", "req"])
        self.assertEqual(res["split"], [])

    def test_multiple_servers_are_only_suggested_and_share_common_lines(self):
        text = "CPU 2소켓\n[DB 서버] 2대\n메모리 512GB 이상\n[APP 서버] 6대\n메모리 128GB"
        res = self.client.post("/api/paste", json={"text": text}).json()
        self.assertEqual([g["name"] for g in res["split"]], ["DB 서버", "APP 서버"])
        self.assertEqual(res["common_lines"], 1)
        for group in res["split"]:
            self.assertIn("cpu_sockets", [r["key"] for r in group["requirements"]])
        self.assertEqual([r["key"] for r in res["server"]["requirements"]].count("memory_gb"), 2)

    def test_quote_lines_are_parts_or_skipped(self):
        text = "PYBCP70X2\tIntel Xeon 6515P 16C 2.3 GHz\t1\nPYBME64ST\t64GB (1x64GB) 2Rx4 DDR5-6400 R ECC\t4\nPYBRR0C\tRack Mount Kit QRL\t1"
        res = self.client.post("/api/paste", json={"text": text, "kind": "quote"}).json()
        self.assertEqual(res["server"]["doc_role"], "quote")
        self.assertEqual([l["status"] for l in res["server"]["lines"]], ["part", "part", "skip"])  # 본체 행 없이 부품만 긁어 와도 견적으로



# ───────────── AI 정규화 (모델 응답을 모의로 넣어 확인) ─────────────
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


class AiNormalizeFieldTests(unittest.TestCase):
    def test_drive_form_factor_variants(self):
        for raw in ('2.5"', "2.5 inch", "SFF", "2.5' H-P"):
            self.assertEqual(A._norm_ff(raw), "2.5")
        self.assertEqual(A._norm_ff("3.5 LFF"), "3.5")
        self.assertEqual(A._norm_iface("SATA 6G"), "SATA")
        self.assertEqual(A._attrs({"category": "drive", "name": "SSD SATA 6G 960GB MU 2.5' H-P", "unit_capacity_gb": 960,
                                   "interface": "SATA 6G", "form_factor": "2.5 inch", "media": "SSD"})["ff"], "2.5")


class RefineOtherTests(unittest.TestCase):
    def test_other_is_asked_again_with_context(self):
        first = {"document_type": "requirement", "common_requirements": [], "ignored_lines": [],
                 "server_groups": [{"name": "", "quantity": None, "requirements": [
                     {"lines": [1], "category": "other", "text": "이중전원(Redundant Power) 지원"},
                     {"lines": [2], "category": "other", "text": "SSO 인증"}]}]}
        blank = {k: None for k in ("operator", "speed_gbps", "min_ports", "ports_per_card", "card_quantity", "min_capacity_gb",
                                   "min_count", "min_size_gb", "min_total_gb", "min_cores", "core_scope", "raid_level",
                                   "watt", "version", "boot")}
        second = {"items": [{**blank, "lines": [1], "category": "psu", "required": True, "text": ""},
                            {**blank, "lines": [2], "category": "other", "required": None, "text": "SSO 인증"}]}
        with patch.dict("os.environ", ENV, clear=False), patch.object(A, "_ask", side_effect=[first, second]):
            result = A.normalize("requirement", ["이중전원(Redundant Power) 지원", "SSO 인증"])
        cats = [r["category"] for r in result["server_groups"][0]["requirements"]]
        self.assertEqual(cats, ["psu", "other"])


class SuggestServerTests(unittest.TestCase):
    def test_variant_suffix_maps_to_family(self):
        from . import proposal
        servers = [{"id": "dell_r760", "model": "R760"}, {"id": "dell_r660", "model": "R660"}]
        self.assertEqual(proposal.suggest_server("R660xs", servers), "dell_r660")
        self.assertEqual(proposal.suggest_server("PowerEdge R760 XA", servers) or proposal.suggest_server("R760XA", servers), "dell_r760")
        self.assertIsNone(proposal.suggest_server("RX2540 M8", servers))


class ModelOnlyLineTests(unittest.TestCase):
    def test_model_only_line_is_heading_not_unread(self):
        lines = A._tag_lines(["PowerEdge R660xs", "CPU 16코어 이상"], [], [])
        self.assertEqual(lines[0]["status"], "head")


class SpecConditionTests(unittest.TestCase):
    TEXT = "PowerEdge R660xs\n가. CPU : 2.8Ghz이상 16코어이상 / 메모리 : 128GB이상\n나. HDD : SSD SATA 1.92TB * 2EA이상"

    def _reqs(self):
        out = A._server({"requirements": extract.extract_requirements(self.TEXT)}, self.TEXT)
        return {r["key"]: r for r in out["requirements"]}

    def test_every_condition_of_a_line_is_kept(self):
        r = self._reqs()
        self.assertEqual(r["cpu_ghz"]["value"], 2.8)
        self.assertEqual(r["cpu_cores"]["value"], 16)
        self.assertNotIn("cpu_sockets", r)          # '2.8' 이 소켓 수 2 로 읽히면 안 됨
        self.assertEqual((r["disk_media"]["value"], r["disk_iface"]["value"]), ("SSD", "SATA"))
        self.assertEqual((r["disk_size_gb"]["value"], r["disk_count"]["value"]), (1920.0, 2))

    def test_ai_missing_conditions_are_completed(self):
        ai = [{"id": "a", "key": "disk_count", "label": "Disk", "op": ">=", "value": 2, "unit": "EA", "source": "나. HDD : SSD SATA 1.92TB * 2EA이상",
               "status": "auto", "note": "", "line": 2, "lines": [2], "how": "ai"}]
        out = A._server({"requirements": ai}, self.TEXT)
        keys = {r["key"] for r in out["requirements"]}
        self.assertTrue({"disk_media", "disk_iface", "disk_size_gb"} <= keys)

    def test_validation_checks_each_condition(self):
        from . import validate as V
        import json
        server = next(s for s in json.load(open("data/servers.json", encoding="utf-8"))["servers"] if s["id"] == "dell_r660")
        reqs = list(self._reqs().values())
        cfg = {"cpu_model": "Xeon Gold 6430", "cpu_count": 2, "memory": [{"size_gb": 64, "qty": 4}], "raid": {"boot": "", "data": ""},
               "bays": {"0": {"drive": "ssd1920_sas", "role": "data"}, "1": {"drive": "ssd1920_sas", "role": "data"}},
               "slots": {}, "risers": [], "psu_watt": 1100, "psu_count": 2, "backplane": server["backplanes"][0]["id"], "boss": False}
        res = {r["requirement"].split()[0] + r["requirement"].split()[1]: r for r in V.validate(server, cfg, reqs, {})["requirements"]}
        by = {x["requirement"]: x["status"] for x in V.validate(server, cfg, reqs, {})["requirements"]}
        self.assertEqual(by["CPU Clock >= 2.8GHz"], "미충족")        # 6430 은 2.1GHz
        self.assertEqual(by["Disk Type SSD"], "충족")
        self.assertEqual(by["Disk Interface SATA"], "미충족")        # 대체 허용 근거 없으면 SAS ≠ SATA
        self.assertEqual(by["Disk Size >= 1.92e+03GB"] if "Disk Size >= 1.92e+03GB" in by else by[[k for k in by if k.startswith("Disk Size")][0]], "충족")
        self.assertTrue(res)


class PreservedConditionTests(unittest.TestCase):
    TEXT = ("가. CPU : 2.8Ghz이상 16코어이상 / 메모리 : DDR5 RDIMM 128GB이상\n나. SSD SATA 1.92TB * 2EA이상\n"
            "다. NIC : 10GbE 이상 SFP+ 2포트\n라. OS : Red Hat Enterprise Linux 64bit 9.2 이상")

    def _by_key(self):
        out = A._server({"requirements": extract.extract_requirements(self.TEXT)}, self.TEXT)
        return {r["key"]: r for r in out["requirements"]}

    def test_unverified_conditions_are_kept_as_review(self):
        r = self._by_key()
        self.assertEqual((r["memory_type"]["value"], r["memory_type"]["status"]), ("DDR5 RDIMM", "review"))
        self.assertEqual((r["nic_media"]["value"], r["nic_media"]["status"]), ("SFP+", "review"))
        self.assertIn("9.2", r["os_spec"]["value"])

    def test_sata_vs_sas_is_fail_unless_text_allows_substitute(self):
        from . import validate as V
        import json
        with open("data/servers.json", encoding="utf-8") as f:
            server = next(s for s in json.load(f)["servers"] if s["id"] == "dell_r660")
        cfg = {"cpu_model": "Xeon Gold 6430", "cpu_count": 2, "memory": [], "raid": {"boot": "", "data": ""},
               "bays": {"0": {"drive": "ssd1920_sas", "role": "data"}}, "slots": {}, "risers": [], "psu_watt": 1100, "psu_count": 2,
               "backplane": server["backplanes"][0]["id"], "boss": False}
        def status(text, waiver=None):
            out = A._server({"requirements": extract.extract_requirements(text)}, text)
            reqs = [r for r in out["requirements"] if r["key"] == "disk_iface"]
            if waiver:
                reqs[0]["waiver"] = waiver
            return V.validate(server, cfg, reqs, {})["requirements"][0]
        self.assertEqual(status("SSD SATA 1.92TB 2EA 이상")["status"], "미충족")
        self.assertEqual(status("SSD SATA 1.92TB 2EA 이상 (동급 이상 대체 가능)")["status"], "확인 필요")
        waived = status("SSD SATA 1.92TB 2EA 이상", {"basis": "고객 메일 승인"})
        self.assertEqual(waived["status"], "충족")
        self.assertIn("고객 메일 승인", waived["note"])
