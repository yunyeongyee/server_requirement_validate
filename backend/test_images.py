"""서버 그림은 실제 이미지(스텐실)만 쓴다 — 그려 낸 도면으로 대신하지 않는다."""
import json, unittest
from pathlib import Path
from unittest.mock import patch
from . import images as I

SERVERS = json.loads((Path(__file__).resolve().parent.parent / "data" / "servers.json").read_text(encoding="utf-8"))["servers"]


class RealImageOnlyTests(unittest.TestCase):
    def test_no_real_image_means_no_picture(self):
        with patch.object(I, "_map", return_value={"servers": {}}), patch.object(I, "library", return_value=[]):
            for s in SERVERS:
                with self.subTest(server=s["id"]):
                    self.assertEqual(I.rear_item(s)[0], None)
                    for bp in s["backplanes"]:
                        self.assertEqual(I.front_item(s, bp["id"])[0], None)


class BrokenMapTests(unittest.TestCase):
    """git pull --autostash 충돌로 설정 파일에 <<<<<<< 가 남아도 500 대신 복구해서 동작."""
    def test_conflicted_json_is_recovered(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "image_map.json"
            path.write_text('<<<<<<< Updated upstream\n{"servers": {"a": 1}}\n=======\n{"servers": {"b": 2}}\n>>>>>>> Stashed changes\n', encoding="utf-8")
            self.assertEqual(I._read_json(path, {}), {"servers": {"a": 1}})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"servers": {"a": 1}})
            self.assertTrue(list(Path(d).glob("image_map.json.broken-*")))


class CustomAnnotTests(unittest.TestCase):
    def test_custom_annotation_extends_canvas_and_draws_links(self):
        import json
        from PIL import Image
        base = Image.new("RGBA", (1000, 200), (230, 230, 230, 255))
        server = {"slots": [{"id": "S1", "hotspot": {"x": 10, "y": 10, "w": 20, "h": 30}}], "psu_slots": []}
        annot = {"show": True, "labels": [{"id": "a", "view": "rear", "text": "Card · 2 EA", "x": 20, "y": -20, "color": "#2f7de1"}],
                 "links": [{"id": "l", "view": "rear", "from": "a", "to": {"kind": "slot", "id": "S1"}, "color": "#2f7de1", "width": 2,
                            "dash": False, "arrowStart": False, "arrowEnd": True, "elbow": True}]}
        out = I._annotate_custom(base, server, "rear", annot, None)
        self.assertGreater(out.height, base.height)        # 그림 밖 라벨 자리만큼 여백
        self.assertIn(I._annot_sig(annot, "rear") is not None, [True])
        self.assertIsNone(I._annot_sig({"show": False, "labels": annot["labels"]}, "rear"))
