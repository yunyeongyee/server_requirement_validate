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
