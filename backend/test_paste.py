"""붙여넣기 분석·규칙 보강·작업 저장 테스트."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from . import extract
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
        res = self.client.post("/api/paste", json={"text": text}).json()
        self.assertEqual(res["server"]["doc_role"], "quote")
        self.assertEqual([l["status"] for l in res["server"]["lines"]], ["part", "part", "skip"])  # 본체 행 없이 부품만 긁어 와도 견적으로


class ProjectSaveTests(unittest.TestCase):
    """저장하기: 같은 이름은 덮어쓰고, 목록·불러오기가 된다 (임시 폴더에)."""
    def test_save_list_load(self):
        import tempfile
        from pathlib import Path
        from fastapi.testclient import TestClient
        from . import app as app_module
        with tempfile.TemporaryDirectory() as d, patch.object(app_module, "PROJECTS", Path(d)):
            client = TestClient(app_module.app)
            first = client.post("/api/projects", json={"name": "견적.xlsx", "state": {"groups": [{"id": "g1"}]}}).json()
            again = client.post("/api/projects", json={"name": "견적.xlsx", "state": {"groups": [{"id": "g1"}, {"id": "g2"}]}}).json()
            self.assertEqual(first["id"], again["id"])
            rows = client.get("/api/projects").json()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["servers"], 2)
            self.assertEqual(client.get(f"/api/projects/{first['id']}").json()["state"]["groups"][1]["id"], "g2")
            self.assertEqual(client.get("/api/projects/..%2Fx").status_code, 404)


if __name__ == "__main__":
    unittest.main()
