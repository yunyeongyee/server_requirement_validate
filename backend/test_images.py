"""기본 도면: 모든 서버·백플레인에서 베이 수만큼, 섀시 안에, 서로 겹치지 않게 배치되는지."""
import json, unittest
from pathlib import Path
from . import images as I

SERVERS = json.loads((Path(__file__).resolve().parent.parent / "data" / "servers.json").read_text(encoding="utf-8"))["servers"]


class SchematicTests(unittest.TestCase):
    def test_every_backplane_gets_all_bays_inside_without_overlap(self):
        for s in SERVERS:
            for bp in s["backplanes"]:
                if not bp["bays"]:
                    continue
                _, _, rects = I._schematic_layout(s, bp)
                with self.subTest(server=s["id"], backplane=bp["id"]):
                    self.assertEqual(len(rects), bp["bays"])
                    for r in rects:
                        self.assertTrue(0 <= r["x"] and r["x"] + r["w"] <= 100 and 0 <= r["y"] and r["y"] + r["h"] <= 100)
                    for i, a in enumerate(rects):
                        for b in rects[i + 1:]:
                            overlap = a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]
                            self.assertFalse(overlap)

    def test_35_bays_are_landscape(self):
        s = next(x for x in SERVERS if x["id"] == "dell_r760")
        bp = next(b for b in s["backplanes"] if b["ff"] == "3.5")
        W, H, rects = I._schematic_layout(s, bp)
        self.assertGreater(rects[0]["w"] / 100 * W, rects[0]["h"] / 100 * H)


class RearSchematicTests(unittest.TestCase):
    def test_every_slot_and_psu_has_a_place_without_overlap(self):
        for s in SERVERS:
            _, _, layout = I._rear_layout(s)
            ids = [x["id"] for x in s["slots"]] + [p["id"] for p in s.get("psu_slots", [])]
            with self.subTest(server=s["id"]):
                self.assertTrue(set(ids) <= set(layout))
                rects = [layout[i] for i in ids]
                for r in rects:
                    self.assertTrue(0 <= r["x"] and r["x"] + r["w"] <= 100 and 0 <= r["y"] and r["y"] + r["h"] <= 100)
                for i, a in enumerate(rects):
                    for b in rects[i + 1:]:
                        self.assertFalse(a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"])
