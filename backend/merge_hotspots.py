"""git stash 에 치워 둔 내 servers.json 의 '좌표 보정 값'(슬롯·PSU hotspot, 후면 막은 영역)만 현재 servers.json 에 옮긴다.
사용: python -m backend.merge_hotspots [stash@{0}]   — 줄바꿈(CRLF/LF)은 현재 파일의 것을 그대로 쓴다."""
import json, subprocess, sys
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "data" / "servers.json"


def main(ref: str = "stash@{0}") -> int:
    mine = json.loads(subprocess.run(["git", "show", f"{ref}:data/servers.json"], capture_output=True, check=True).stdout.decode("utf-8"))
    raw = PATH.read_bytes()
    crlf = b"\r\n" in raw
    cur = json.loads(raw.decode("utf-8"))
    by_id = {s["id"]: s for s in cur["servers"]}
    changed = 0
    for old in mine["servers"]:
        new = by_id.get(old["id"])
        if not new:
            continue
        for key in ("slots", "psu_slots"):
            ids = {x["id"]: x for x in new.get(key, [])}
            for x in old.get(key, []):
                if x.get("hotspot") and x["id"] in ids and ids[x["id"]].get("hotspot") != x["hotspot"]:
                    ids[x["id"]]["hotspot"] = x["hotspot"]; changed += 1
        if "rear_blocked" in old and new.get("rear_blocked") != old["rear_blocked"]:
            new["rear_blocked"] = old["rear_blocked"]; changed += 1
    text = json.dumps(cur, ensure_ascii=False, indent=2)
    PATH.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode("utf-8"))
    print(f"좌표 보정 값 {changed}곳을 옮겼습니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:2]))
