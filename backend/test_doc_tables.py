"""양식이 서로 다른 문서들로 구조 해석을 검증한다. 특정 양식 전용 분기가 생기지 않도록 형식별로 하나씩 둔다."""
import io, unittest
from pathlib import Path
import openpyxl
from . import doc_tables as D

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def xlsx(sheets):
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    b = io.BytesIO(); wb.save(b); return b.getvalue()


class FormatVarietyTests(unittest.TestCase):
    def test_summary_sheet_plus_detail_sheets(self):
        p = SAMPLES / "quote_kgict.xlsx"
        if not p.exists():
            self.skipTest("참고 견적서 없음")
        r = D.analyze_document(p.name, p.read_bytes(), "")
        self.assertEqual(r["doc_role"], "quote")
        self.assertEqual([(g["name"], g["quantity"]) for g in r["groups"]], [("DB서버", 2), ("APP 서버", 6), ("개발서버", 1)])
        db = r["groups"][0]["proposed"]
        self.assertEqual(db["cpu"]["count"], 2)
        self.assertEqual(db["memory"]["total_gb"], 512)
        self.assertEqual(r["groups"][1]["proposed"]["memory"]["total_gb"], 128)   # 같은 품명의 다른 코드(16GB ×2 + ×6) 합산
        self.assertFalse(any("7620000" in i["value"] for g in r["groups"] for c in g["spec"] for i in c["items"]))  # 가격 미표시

    def test_single_sheet_split_by_base_unit_rows_english_headers(self):
        data = xlsx([("Quote", [
            ["Item", "Part Number", "Description", "Qty", "Unit Price", "Ext Price"],
            [1, "R760-BASE", "PowerEdge R760 Base Unit 8x2.5", 1, 9000000, 9000000],
            [2, "338-CHTX", "Intel Xeon Gold 6430 32C 2.1GHz", 2, 3000000, 6000000],
            ["Subtotal", "", "", "", "", 15000000],
            [3, "R660-BASE", "PowerEdge R660 Base Unit 10x2.5", 1, 7000000, 7000000],
            [4, "370-AGZP", "32GB RDIMM DDR5 4800", 4, 400000, 1600000]])])
        r = D.analyze_document("d.xlsx", data, "")
        self.assertEqual([g["model_hint"] for g in r["groups"]], ["R760", "R660"])

    def test_detail_quantities_given_as_totals_are_converted_per_unit(self):
        data = xlsx([("WEB 서버", [["WEB 서버"], ["No", "품번", "품명", "수량", "금액"],
                                  [1, "X1", "ThinkSystem SR650 V3 Chassis", 2, 1],
                                  [2, "X2", "Intel Xeon Gold 5418Y 24C 2.0GHz", 4, 1],
                                  [3, "X3", "32GB TruDDR5 RDIMM", 16, 1]])])
        g = D.analyze_document("e.xlsx", data, "")["groups"][0]
        self.assertEqual((g["quantity"], g["proposed"]["cpu"]["count"], g["proposed"]["memory"]["total_gb"]), (2, 2, 256))

    def test_column_per_server_spec_table(self):
        data = xlsx([("사양", [["구분", "DB 서버", "WAS 서버"], ["수량", "2대", "4대"],
                              ["Memory", "1TB 이상", "256GB 이상"], ["NIC", "25GbE 4Port 이상", "10GbE 2Port"]])])
        r = D.analyze_document("b.xlsx", data, "")
        self.assertEqual(r["doc_role"], "requirement")
        self.assertEqual([(g["name"], g["quantity"]) for g in r["groups"]], [("DB 서버", 2), ("WAS 서버", 4)])
        mem = next(x for x in r["groups"][0]["requirements"] if x["key"] == "memory_gb")
        self.assertEqual(mem["value"], 1024)

    def test_text_document_with_headings(self):
        text = "가. DB 서버 (2식)\nCPU : 2소켓 이상\n메모리 : 512GB 이상\n나. WAS 서버 (4식)\n메모리 : 256GB 이상"
        r = D.analyze_document("c.txt", text.encode(), text)
        self.assertEqual([(g["name"], g["quantity"]) for g in r["groups"]], [("DB 서버", 2), ("WAS 서버", 4)])


if __name__ == "__main__":
    unittest.main()


class SheetPerServerTests(unittest.TestCase):
    def test_config_sheet_per_server(self):
        """서버 구성도: 시트마다 서버 1대, 한 칸에 'CPU : … / MEM : … / HDD : …', 옆 칸에 다른 표."""
        rows = lambda name: [
            [f"{name} 서버"],
            ["CPU : Intel Xeon Gold 6544Y 16C 3.6GHz / MEM : DDR5-4800 64GB / HDD : SATA 1.92TB * 2EA", None, None, "OS Local (RAID1)"],
            [None, "HDD7"], [None, "HDD6"],
            ["I350-T4 4port 1000BASE-T | X710-DA4 4port 10Gb SFP", None, None, "Hostname", "HOST1"],
        ]
        data = xlsx([("납품장비리스트", [["구분", "용도", "모델명", "수량"], ["서버", "체계관리", "PowerEdge R760", 2]]),
                     ("Window 서버_WAS서버", rows("WAS")), ("Window 서버_DB서버", rows("DB"))])
        r = D.analyze_document("구성도.xlsx", data, "")
        self.assertEqual([g["name"] for g in r["groups"]], ["WAS 서버", "DB 서버"])
        cats = {s["category"] for s in r["groups"][0]["spec"]}
        self.assertTrue({"CPU", "Memory", "Disk"} <= cats)
        # 구성도 → 요구사항이 아니라 적용할 구성
        g = r["groups"][0]
        self.assertEqual(g["doc_role"], "config")
        self.assertEqual(g["requirements"], [])
        self.assertEqual(g["proposed"]["cpu"]["model"], "Xeon Gold 6544Y")
        self.assertEqual(g["proposed"]["drives"][0]["qty"], 2)
        self.assertEqual(sorted(n.get("ports") for n in g["proposed"]["nic"]), [4, 4])
        self.assertTrue(any("RAID1" in r for r in g["proposed"]["raid"]))
        # 디스크 칸 이름(HDD7 등)이 서버로 잡히지 않아야 한다
        self.assertFalse(any("HDD" in g["name"] for g in r["groups"]))

    def test_inventory_links_quantity_when_names_match(self):
        sheet = lambda name: [[f"{name} 서버"], ["CPU : Intel Xeon Gold 6430 / MEM : 64GB / HDD : SSD 960GB * 2EA"]]
        data = xlsx([("장비목록", [["구분", "용도", "모델명", "수량"], ["서버", "WAS 서버", "PowerEdge R760", 3], ["서버", "백업", "PowerEdge R660", 1]]),
                     ("WAS", sheet("WAS")), ("DB", sheet("DB"))])
        r = D.analyze_document("구성도.xlsx", data, "")
        self.assertEqual([row["name"] for row in r["inventory"]], ["WAS 서버", "백업"])
        self.assertEqual([(g["name"], g["quantity"]) for g in r["groups"]], [("WAS 서버", 3), ("DB 서버", None)])



class PasteTests(unittest.TestCase):
    def test_pasted_parts_list_without_header_or_price(self):
        """엑셀에서 복사한 '품번 탭 품명 탭 수량' 목록(머리글·가격 없음) → 제안 구성"""
        data = (Path(__file__).resolve().parent / "testdata" / "paste_parts.tsv").read_bytes()
        r = D.analyze_document("붙여넣기.tsv", data, data.decode("utf-8"))
        self.assertEqual(r["doc_role"], "quote")
        self.assertEqual(len(r["groups"]), 1)
        p = r["groups"][0]["proposed"]
        self.assertEqual(p["cpu"]["model"], "Xeon 6515P")
        self.assertEqual(p["memory"]["total_gb"], 256)
        self.assertEqual(p["drives"][0]["qty"], 2)
        self.assertEqual(p["psu"], {"desc": "Modular PSU 1600W platinum hp", "watt": 1600, "count": 2})
        self.assertEqual(len(p["nic"]) + len(p["ocp"]), 3)
        cats = {i["category"] for i in r["groups"][0]["items"]}
        self.assertIn("accessory", cats)  # 케이블·레일은 부속으로 분리

    def test_pasted_requirement_sentences_stay_requirements(self):
        text = "서버 요구사항\nCPU 2소켓 이상\n메모리 512GB 이상\n"
        r = D.analyze_document("붙여넣기.tsv", text.encode(), text)
        self.assertEqual(r["doc_role"], "requirement")
