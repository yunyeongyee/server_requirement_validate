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
