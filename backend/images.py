# 이미지 관리 / 렌더링
"""실제 이미지 엔진.

- 라이브러리 : VSSX/VSDX 마스터(또는 PNG/JPG)에서 추출한 실제 이미지 목록
- 작업(job)  : 대용량 스텐실 추출은 백그라운드 스레드 + 진행률
- 매핑       : 서버 전면(백플레인별)/후면, 디스크, 부품 → 라이브러리 이미지
               기본은 스텐실 이름으로 자동 매칭(servers.json/components.json 의 stencil 필드), 사용자가 바꾸면 덮어씀
- 베이 감지  : 전면 이미지에서 드라이브 베이 위치를 자동 감지 (실패 시 좌표 보정)
- 합성       : 실제 전면/후면 이미지 + 장착 디스크/OCP 이미지 → PNG (입력 해시 캐시)
"""
from __future__ import annotations
import hashlib, math, io, json, re, threading, time, traceback, uuid
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import visio

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "static" / "images" / "library"
RENDERS = ROOT / "static" / "renders"
import logging
log = logging.getLogger(__name__)
MANIFEST = LIB / "manifest.json"
MAPFILE = ROOT / "data" / "image_map.json"
for d in (LIB, RENDERS):
    d.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()


# =============================================================== 라이브러리
_CONFLICT = re.compile(r"^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n?", re.S | re.M)


def _read_json(path: Path, default):
    """JSON 파일 읽기. 'git pull --autostash' 충돌로 <<<<<<< 표시가 남아 깨졌으면
    받은 쪽(새 코드) → 내 쪽 순으로 복구해 다시 저장하고, 깨진 원본은 .broken 으로 남긴다. 둘 다 안 되면 기본값."""
    if not path.exists():
        return default
    text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except ValueError:
        pass
    backup = path.with_name(path.name + f".broken-{time.strftime('%Y%m%d-%H%M%S')}")
    backup.write_text(text, encoding="utf-8")
    for side in (1, 2):
        try:
            data = json.loads(_CONFLICT.sub(lambda m: m.group(side), text))
        except ValueError:
            continue
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        log.warning("%s 가 깨져 있어 복구했습니다 (원본: %s)", path.name, backup.name)
        return data
    log.error("%s 를 읽을 수 없어 비워서 시작합니다 (원본: %s)", path.name, backup.name)
    return default


def library() -> list[dict]:
    with _lock:
        return _read_json(MANIFEST, [])


def _save_library(items):
    with _lock:
        MANIFEST.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def item(item_id: str | None) -> dict | None:
    return next((i for i in library() if i["id"] == item_id), None) if item_id else None


def by_name(name: str | None) -> dict | None:
    """같은 이름이 여러 번 추출됐으면 가장 최근 것."""
    if not name:
        return None
    n = name.casefold()
    hits = [i for i in library() if i.get("file") and i["name"].casefold() == n]
    return hits[-1] if hits else None


def delete_item(item_id: str):
    items = library()
    for i in items:
        if i["id"] == item_id and i.get("file"):
            (ROOT / "static" / i["file"]).unlink(missing_ok=True)
    _save_library([i for i in items if i["id"] != item_id])


def _ingest(filename: str, data: bytes, progress) -> list[dict]:
    ext = Path(filename).suffix.lower()
    new = []
    if ext in (".vssx", ".vsdx", ".vstx"):
        tmp = LIB / f"_up_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(data)
        try:
            for it in visio.extract(tmp, LIB, progress):
                f = it.pop("file")
                new.append({"id": uuid.uuid4().hex[:10], "source": Path(filename).name,
                            "file": f"images/library/{f.name}" if f else None, **it})
        finally:
            tmp.unlink(missing_ok=True)
    elif ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
        iid = uuid.uuid4().hex[:10]
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        out = LIB / f"up_{iid}.png"
        im.save(out)
        new.append({"id": iid, "name": Path(filename).stem, "category": visio.classify(Path(filename).stem),
                    "source": "업로드", "file": f"images/library/{out.name}", "px": im.size,
                    "w_in": round(im.width / visio.PPI, 3), "h_in": round(im.height / visio.PPI, 3)})
    else:
        raise ValueError(f"지원하지 않는 형식: {filename} (VSSX/VSDX/PNG/JPG)")
    _save_library(library() + new)
    return new


# =============================================================== 백그라운드 작업
JOBS: dict[str, dict] = {}
STAGE_KO = {"parse": "스텐실 해석", "convert": "EMF → 이미지 변환", "render": "쉐이프 이미지 합성"}


def start_ingest(files: list[tuple[str, bytes]]) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "state": "running", "stage": "", "done": 0, "total": 0, "message": "준비 중…",
           "added": 0, "failed": 0, "started": time.time()}
    JOBS[jid] = job

    def progress(stage, done, total):
        job.update(stage=stage, done=done, total=total, message=f"{STAGE_KO.get(stage, stage)} {done}/{total}")

    def run():
        try:
            for name, data in files:
                job["file"] = name
                new = _ingest(name, data, progress)
                job["added"] += sum(1 for i in new if i.get("file"))
                job["failed"] += sum(1 for i in new if not i.get("file"))
            job.update(state="done", message=f"이미지 {job['added']}개 추출 완료"
                       + (f", {job['failed']}개 실패" if job["failed"] else ""))
        except Exception as e:
            traceback.print_exc()
            job.update(state="error", message=str(e))
        job["elapsed"] = round(time.time() - job["started"], 1)

    threading.Thread(target=run, daemon=True).start()
    return jid


# =============================================================== 매핑
def _map() -> dict:
    with _lock:
        m = _read_json(MAPFILE, {})
    m.setdefault("servers", {}); m.setdefault("components", {}); m.setdefault("drives", {}); m.setdefault("psus", {})
    return m


def _save_map(m):
    with _lock:
        MAPFILE.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def set_map(server_id: str, kind: str, key: str, item_id: str | None):
    m = _map()
    if kind == "front":
        tgt = m["servers"].setdefault(server_id, {}).setdefault("front", {})
    elif kind == "rear":
        tgt, key = m["servers"].setdefault(server_id, {}), "rear"
    elif kind == "component":
        tgt = m["components"]
    elif kind == "drive":
        tgt = m["drives"]
    elif kind == "psu":  # key: 용량(W)
        tgt = m["psus"]
    else:
        raise ValueError(kind)
    if item_id:
        tgt[key] = item_id
    else:
        tgt.pop(key, None)
    _save_map(m)


def front_item(server, bp_id) -> tuple[dict | None, bool]:
    ov = _map()["servers"].get(server["id"], {}).get("front", {}).get(bp_id)
    if ov and item(ov):
        return item(ov), False
    bp = next((b for b in server.get("backplanes", []) if b["id"] == bp_id), None)
    found = by_name(bp.get("stencil") if bp else None)
    # 실제 이미지(스텐실)만 쓴다. 없으면 그림 없이 — 그려 낸 도면으로 대신하지 않는다
    return found, True


def rear_item(server) -> tuple[dict | None, bool]:
    ov = _map()["servers"].get(server["id"], {}).get("rear")
    if ov and item(ov):
        return item(ov), False
    found = by_name(server.get("rear_stencil"))
    return found, True


def rear_spot(server, base_it: dict | None, sid: str, saved: dict | None) -> dict | None:
    """슬롯·PSU 위치: 실제 이미지에서 보정한(저장된) 좌표."""
    return saved


def comp_item(comp: dict) -> tuple[dict | None, bool]:
    ov = _map()["components"].get(comp["id"])
    if ov and item(ov):
        return item(ov), False
    return by_name(comp.get("stencil")), True


def psu_item(watt) -> tuple[dict | None, bool, bool]:
    """PSU 용량 → (이미지, 자동 여부, 같은 용량 이미지인지).
    직접 연결 > 이름에 같은 W가 있는 PSU 이미지 > 가장 가까운 W의 PSU 이미지(대체)."""
    ov = _map()["psus"].get(str(int(watt))) if watt else None
    if ov and item(ov):
        return item(ov), False, True
    cands = []
    for it in library():
        if it.get("file") and it.get("category") == "psu":
            m = re.search(r"(\d{3,4})\s*w\b", it["name"], re.I)
            if m:
                cands.append((int(m.group(1)), it))
    if not cands or not watt:
        return None, True, False
    exact = [it for w, it in cands if w == int(watt)]
    if exact:
        return exact[-1], True, True
    return min(cands, key=lambda c: abs(c[0] - watt))[1], True, False


def drive_item(drive: dict, orient: str) -> tuple[dict | None, bool]:
    """orient: V(세로 베이) / H(가로 베이). 3.5\" 는 방향 구분 없음."""
    key = f"{drive['id']}:{orient}"
    ov = _map()["drives"].get(key)
    if ov and item(ov):
        return item(ov), False
    base = drive.get("stencil")
    if not base:
        return None, True
    if drive.get("ff") == "2.5":
        return by_name(f"{base} ({orient})") or by_name(f"14G 2.5 SAS ({orient})"), True
    return by_name(base) or by_name("14G 3.5 SAS"), True


# =============================================================== 베이 자동 감지
BAY_ALGO = 2  # 베이 감지 방식 버전. 바꾸면 자동 감지 결과를 다시 계산한다.
DRIVE_FACE = {"2.5": [(0.603, 2.853), (2.853, 0.603)], "3.5": [(4.103, 1.028)]}


def _runs(mask) -> list[tuple[int, int]]:
    out, s = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append((s, i)); s = None
    return out


def _repeated_cells(a: np.ndarray) -> list[list]:
    """밝은 구분선으로 나뉜 칸 중 같은 크기(±8%)로 가장 많이 반복되는 묶음. 통풍구 구멍처럼 작은 칸은 제외."""
    H, W = a.shape
    best: list[tuple] = []
    for light in (200, 215, 230, 185, 170):
        band = a[int(H * 0.08):int(H * 0.92)]
        colsep = (band > light).mean(axis=0) > 0.5
        cells = []
        for x0, x1 in _runs(~colsep):
            rowsep = (a[:, x0:x1] > light).mean(axis=1) > 0.5
            for y0, y1 in _runs(~rowsep):
                w, h = x1 - x0, y1 - y0
                if h > 0.25 * H and 0.012 * W < w < 0.3 * W:
                    cells.append((x0, y0, x1, y1))
        for c in cells:
            w, h = c[2] - c[0], c[3] - c[1]
            grp = [d for d in cells if abs((d[2] - d[0]) - w) / w < 0.08 and abs((d[3] - d[1]) - h) / h < 0.08]
            area = lambda g: (g[0][2] - g[0][0]) * (g[0][3] - g[0][1]) if g else 0
            if len(grp) > len(best) or (len(grp) == len(best) and area(grp) > area(best)):
                best = grp
    if len(best) < 2:
        return []
    return [[*c, float(a[c[1]:c[3], c[0]:c[2]].mean())] for c in sorted(set(best))]


def detect_bays(path: Path, ff: str, count: int, ppi_x: float, fill: bool = True) -> tuple[list[dict], bool]:
    """전면 이미지에서 밝은 구분선 사이의 어두운 영역 중 드라이브 크기와 맞는 칸을 베이로 인식."""
    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(int)
    H, W = a.shape
    sizes = [(w * ppi_x, h * ppi_x) for w, h in DRIVE_FACE[ff]]
    # 1) 크기 가정 없이: 같은 크기로 반복되는 칸 묶음 중 가장 많은 것 (E3.S 등 규격이 달라도 동작)
    best = _repeated_cells(a)
    # 2) 실패하면 2.5"/3.5" 드라이브 면 크기로 찾기
    for light in (() if len(best) >= min(count, 4) else (215, 200, 230)):
        band = a[int(H * 0.08):int(H * 0.92)]
        colsep = (band > light).mean(axis=0) > 0.5
        cells = []
        for x0, x1 in _runs(~colsep):
            rowsep = (a[:, x0:x1] > light).mean(axis=1) > 0.5
            for y0, y1 in _runs(~rowsep):
                w, h = x1 - x0, y1 - y0
                for ew, eh in sizes:
                    s, l = (w, h) if ew < eh else (h, w)
                    es, el = min(ew, eh), max(ew, eh)
                    if abs(s - es) / es < 0.12 and abs(l - el) / el < 0.18:
                        cells.append([x0, y0, x1, y1, float(a[y0:y1, x0:x1].mean())]); break
        if cells:
            # 통풍구(메시) 같은 오검출 제거: 평균 밝기·크기가 중앙값과 크게 다르면 제외
            mm = np.median([c[4] for c in cells]); mw = np.median([c[2] - c[0] for c in cells])
            cells = [c for c in cells if abs(c[4] - mm) < 22 and abs((c[2] - c[0]) - mw) / mw < 0.1]
        if len(cells) > len(best):
            best = cells
        if len(best) >= count:
            break
    cells = best
    # 행 단위로 묶어서 부족한 베이는 같은 간격으로 오른쪽에 보충
    if fill and cells and len(cells) < count:
        cells.sort(key=lambda c: (c[1], c[0]))
        rows: list[list] = []
        for c in cells:
            r = next((r for r in rows if abs(r[0][1] - c[1]) < (c[3] - c[1]) / 2), None)
            (r.append(c) if r else rows.append([c]))
        for r in rows:
            r.sort(key=lambda c: c[0])
        changed = True
        while len(cells) < count and changed:
            changed = False
            for r in rows:
                if len(cells) >= count:
                    break
                if len(r) < 2:
                    continue
                pitch = min(r[i + 1][0] - r[i][0] for i in range(len(r) - 1))
                last = r[-1]
                nx = last[0] + pitch
                if nx + (last[2] - last[0]) <= W * 0.985:
                    c = [nx, last[1], nx + last[2] - last[0], last[3], last[4]]
                    r.append(c); cells.append(c); changed = True
    cells = sorted(cells, key=lambda c: (round(c[1] / max(1, (c[3] - c[1]) / 2)), c[0]))[:count]
    rects = [{"x": round(c[0] / W * 100, 3), "y": round(c[1] / H * 100, 3),
              "w": round((c[2] - c[0]) / W * 100, 3), "h": round((c[3] - c[1]) / H * 100, 3)} for c in cells]
    return rects, len(rects) == count


def bays(server, bp: dict, force=False) -> dict:
    """현재 전면 이미지 기준 베이 좌표. 저장된 값이 같은 이미지에서 온 것이면 재사용."""
    fi, _ = front_item(server, bp["id"])
    if not fi or bp["bays"] == 0:
        return {"rects": [], "ok": bp["bays"] == 0, "source": None}
    m = _map()
    store = m["servers"].setdefault(server["id"], {}).setdefault("bays", {})
    saved = store.get(bp["id"])
    # 직접 보정한 좌표는 유지. 예전 감지 방식으로 자동 저장된 값만 다시 감지한다.
    if saved and saved.get("item") == fi["id"] and not force and (saved.get("source") == "manual" or saved.get("algo") == BAY_ALGO):
        return saved
    p = ROOT / "static" / fi["file"]
    ppi = Image.open(p).width / fi["w_in"] if fi.get("w_in") else visio.PPI
    rects, ok = detect_bays(p, bp["ff"], bp["bays"], ppi)
    # 이미지 베이가 백플레인보다 적으면 그림에 없는 칸을 지어내지 않는다
    found = len(bay_candidates(server, bp))
    if found and found < bp["bays"]:
        rects, ok = rects[:found], False
    if not rects:  # 감지 실패 → 보정용 기본 배치
        n = bp["bays"]
        rects = [{"x": 5 + i * 85 / n, "y": 10, "w": 85 / n * 0.9, "h": 80} for i in range(n)]
    saved = {"item": fi["id"], "rects": rects, "ok": ok, "source": "auto", "algo": BAY_ALGO}
    store[bp["id"]] = saved
    _save_map(m)
    return saved


_CANDIDATES: dict[tuple[str, str], list[dict]] = {}


def bay_candidates(server, bp: dict) -> list[dict]:
    """전면 이미지에 실제로 보이는 베이 전부(보충 없이). 이미지가 백플레인보다 베이가 많을 때 어느 칸을 쓸지 고르는 데 쓴다."""
    fi, _ = front_item(server, bp["id"])
    if not fi or not bp["bays"]:
        return []
    key = (fi["id"], bp["ff"])
    if key not in _CANDIDATES:
        p = ROOT / "static" / fi["file"]
        ppi = Image.open(p).width / fi["w_in"] if fi.get("w_in") else visio.PPI
        rects, _ = detect_bays(p, bp["ff"], 64, ppi, fill=False)
        _CANDIDATES[key] = sorted(rects, key=lambda r: (round(r["y"] / max(1, r["h"] / 2)), r["x"]))
    return _CANDIDATES[key]


def save_bays(server, bp_id: str, rects: list[dict]):
    bp = next(b for b in server["backplanes"] if b["id"] == bp_id)
    fi, _ = front_item(server, bp_id)
    m = _map()
    m["servers"].setdefault(server["id"], {}).setdefault("bays", {})[bp_id] = {
        "item": fi["id"] if fi else None, "rects": rects[:bp["bays"]], "ok": True, "source": "manual"}
    _save_map(m)


# =============================================================== 상태 조회
def _brief(it):
    return {"id": it["id"], "name": it["name"], "url": "/static/" + it["file"]} if it and it.get("file") else None


def status(server, comps: list[dict], bp_id: str) -> dict:
    bp = next((b for b in server["backplanes"] if b["id"] == bp_id), server["backplanes"][0])
    fi, fa = front_item(server, bp["id"]); ri, ra = rear_item(server)
    by = bays(server, bp)
    comp_imgs = {}
    for c in comps:
        it, auto = comp_item(c)
        comp_imgs[c["id"]] = {"item": _brief(it), "auto": auto}
    drv = {}
    for d in server.get("drive_options", []):
        for o in (("V", "H") if d["ff"] == "2.5" else ("V",)):
            it, auto = drive_item(d, o)
            drv[f"{d['id']}:{o}"] = {"item": _brief(it), "auto": auto}
    psus = {}
    for w in server.get("psu_options", []):
        it, auto, exact = psu_item(w)
        psus[str(w)] = {"item": _brief(it), "auto": auto, "exact": exact}
    return {"front": {"item": _brief(fi), "auto": fa, "stencil": bp.get("stencil")}, "psus": psus,
            "rear": {"item": _brief(ri), "auto": ra, "stencil": server.get("rear_stencil")},
            "bays": {**by, "candidates": bay_candidates(server, bp)}, "components": comp_imgs, "drives": drv, "library_count": len(library())}


# =============================================================== 합성
def _contain(img: Image.Image, w: int, h: int) -> Image.Image:
    """방향이 다르면 90° 회전 후, 비율 유지하며 영역 안에 맞춤."""
    if (img.width > img.height) != (w > h) and abs(img.width - img.height) > 3:
        img = img.rotate(90, expand=True)
    s = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _backdrop(base: Image.Image, box) -> tuple:
    """영역 안에서 가장 많이 쓰인 색 (원본 PSU 몸체색) — 덮개 색으로 쓴다."""
    x, y, w, h = box
    crop = base.crop((max(0, x), max(0, y), min(base.width, x + w), min(base.height, y + h))).convert("RGB")
    if crop.width < 2 or crop.height < 2:
        return (228, 231, 235)
    counts = crop.quantize(8).convert("RGB").getcolors(crop.width * crop.height) or []
    light = [c for c in counts if sum(c[1]) > 540] or counts
    return max(light, key=lambda c: c[0])[1] if light else (228, 231, 235)


def _dashed(pen, box, color, width, dash=8):
    x0, y0, x1, y1 = box
    for a in range(int(x0), int(x1), dash * 2):
        for y in (y0, y1):
            pen.line((a, y, min(a + dash, x1), y), fill=color, width=width)
    for a in range(int(y0), int(y1), dash * 2):
        for x in (x0, x1):
            pen.line((x, a, x, min(a + dash, y1)), fill=color, width=width)


def _font(px):
    try:
        return ImageFont.load_default(size=px)
    except TypeError:
        return ImageFont.load_default()


def _unused_bay_groups(active: list[dict], candidates: list[dict]) -> list[dict]:
    """이미지에 보이지만 구성에서 쓰지 않는 베이를 붙어 있는 묶음별 사각형으로."""
    def covers(a, b):
        cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        return a["x"] < cx < a["x"] + a["w"] and a["y"] < cy < a["y"] + a["h"]
    unused = sorted([c for c in candidates if not any(covers(a, c) or covers(c, a) for a in active)], key=lambda r: (r["y"], r["x"]))
    groups: list[list[dict]] = []
    for r in unused:
        g = groups[-1] if groups else None
        last = g[-1] if g else None
        if last and abs(last["y"] - r["y"]) < r["h"] / 2 and r["x"] - (last["x"] + last["w"]) < r["w"] * 0.8:
            g.append(r)
        else:
            groups.append([r])
    out = []
    for g in groups:
        x0 = min(r["x"] for r in g); y0 = min(r["y"] for r in g)
        x1 = max(r["x"] + r["w"] for r in g); y1 = max(r["y"] + r["h"] for r in g)
        out.append({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0})
    return out


def render(server, cfg, view, catalog: dict, caption: dict | None = None, annot: dict | None = None) -> dict:
    if view == "front":
        bp = next((b for b in server["backplanes"] if b["id"] == cfg.get("backplane")), server["backplanes"][0])
        base_it, _ = front_item(server, bp["id"])
    else:
        bp = None
        base_it, _ = rear_item(server)
    if not base_it:
        return {"url": None, "reason": "이미지 미지정"}
    base_p = ROOT / "static" / base_it["file"]
    layers, labels, missing, empties, stretch, blanks, psu_layers = [], [], [], [], [], [], []
    if view == "front":
        rects = bays(server, bp)["rects"]
        opts = {d["id"]: d for d in server.get("drive_options", [])}
        for k, b in (cfg.get("bays") or {}).items():
            i = int(k)
            if i >= len(rects) or b.get("drive") not in opts:
                continue
            r = rects[i]
            rw_in = r["w"] / 100 * base_it.get("w_in", 19); rh_in = r["h"] / 100 * base_it.get("h_in", 3.4)
            orient = "V" if rh_in > rw_in else "H"
            it, _ = drive_item(opts[b["drive"]], orient)
            if it:
                layers.append((ROOT / "static" / it["file"], r))
            else:
                missing.append(opts[b["drive"]]["name"])
        # 백플레인이 쓰지 않는 칸(이미지는 16베이, 구성은 8베이 등) → 필러(막음판)로 덮는다
        # 빈 베이: Dell 스텐실은 빈 베이를 실제 블랭크 캐리어로 그려 두므로 그대로 둔다.
        # E3.S 그림만 칸마다 디스크가 그려져 있어 빈 칸을 어둡게 덮는다
        used = {int(k) for k in (cfg.get("bays") or {}) if (cfg["bays"][k] or {}).get("drive") in opts}
        if re.search(r"e3\.s", base_it["name"], re.I):
            blanks.extend(r for i, r in enumerate(rects) if i not in used)
        fillers = _unused_bay_groups(rects, bay_candidates(server, bp))
        # 필러는 그림의 베이 규격을 따른다 (E3.S 그림이면 E3.S 필러)
        img_ff = "E3.S" if re.search(r"e3\.s", base_it["name"], re.I) else bp["ff"]
        filler_it = by_name("2U 17G E3.S Filler") if img_ff == "E3.S" else by_name("2U 17G 2.5in Filler") if img_ff == "2.5" else None
        for box in fillers:
            if filler_it:
                stretch.append((ROOT / "static" / filler_it["file"], box))
            else:
                empties.append(box)
    else:
        for slot in server["slots"]:
            cid = (cfg.get("slots") or {}).get(slot["id"])
            if not cid or cid not in catalog:
                continue
            spot = rear_spot(server, base_it, slot["id"], slot.get("hotspot"))
            if not spot:
                continue
            it, _ = comp_item(catalog[cid])
            if it:
                layers.append((ROOT / "static" / it["file"], spot))
            else:
                labels.append((catalog[cid].get("short") or catalog[cid]["name"], spot))
        # 장착된 PSU: PSU1부터 psu_count 개. 같은 용량 이미지가 없으면 대체 이미지 + 용량 라벨
        watt = cfg.get("psu_watt")
        it, _, exact = psu_item(watt)
        spots = [rear_spot(server, base_it, p["id"], p.get("hotspot")) for p in server.get("psu_slots", [])]
        n_psu = int(cfg.get("psu_count") or 0)
        empties = [sp for sp in spots[n_psu:] if sp]
        for spot in spots[:n_psu]:
            if not spot:
                continue
            if it:
                psu_layers.append((ROOT / "static" / it["file"], spot))
            if not it or not exact:
                labels.append((f"{watt:g}W" if isinstance(watt, (int, float)) else str(watt), spot))
    sig = json.dumps([base_it["id"], base_p.stat().st_mtime,
                      [(str(p), p.stat().st_mtime, r) for p, r in layers], labels, empties,
                      [(str(p), r) for p, r in stretch], blanks, [(str(p), r) for p, r in psu_layers], "psu2", caption, cfg.get("bays") if caption is not None else None, cfg.get("slots") if caption is not None else None, "lb2" if caption is not None else None, _annot_sig(annot, view)], sort_keys=True, default=str)
    out = RENDERS / f"{server['id']}_{view}_{hashlib.sha1(sig.encode()).hexdigest()[:16]}.png"
    if not out.exists():
        with Image.open(base_p) as b:
            base = b.convert("RGBA")
        W, H = base.size
        if blanks:
            pen = ImageDraw.Draw(base, "RGBA")
            for r in blanks:
                x, y, w, h = (W * r["x"] / 100, H * r["y"] / 100, W * r["w"] / 100, H * r["h"] / 100)
                pen.rectangle((x, y, x + w, y + h), fill=(24, 27, 32, 255), outline=(92, 100, 110, 255), width=max(1, round(min(w, h) * 0.03)))
        for p, r in stretch:  # 필러: 영역에 꽉 차게 늘림
            x, y, w, h = (round(W * r["x"] / 100), round(H * r["y"] / 100), round(W * r["w"] / 100), round(H * r["h"] / 100))
            with Image.open(p) as im:
                base.alpha_composite(im.convert("RGBA").resize((max(1, w), max(1, h)), Image.LANCZOS), (x, y))
        def px(r):
            return (round(W * r["x"] / 100), round(H * r["y"] / 100), max(1, round(W * r["w"] / 100)), max(1, round(H * r["h"] / 100)))
        for r in empties:  # 빈 PSU 베이: 원본 그림의 PSU를 바탕색으로 덮고 점선 틀만 남긴다
            x, y, w, h = px(r)
            back = _backdrop(base, (x, y, w, h))
            pen = ImageDraw.Draw(base, "RGBA")
            pen.rectangle((x, y, x + w, y + h), fill=back + (255,))
            _dashed(pen, (x + 2, y + 2, x + w - 2, y + h - 2), (120, 130, 142, 255), max(1, round(min(w, h) * 0.025)))
            f = _font(max(11, int(min(h * 0.18, 22))))
            pen.text((x + w / 2, y + h / 2), "EMPTY", fill=(120, 130, 142, 255), font=f, anchor="mm")
        for p, r in psu_layers:  # PSU: 원본 PSU를 바탕색으로 덮고, 비율이 비슷하면 칸에 맞춰 늘리고 아니면 비율 유지
            x, y, w, h = px(r)
            ImageDraw.Draw(base, "RGBA").rectangle((x, y, x + w, y + h), fill=_backdrop(base, (x, y, w, h)) + (255,))
            with Image.open(p) as im:
                im = im.convert("RGBA")
                if (im.width > im.height) != (w > h) and abs(im.width - im.height) > 3:
                    im = im.rotate(90, expand=True)
                if abs(math.log((im.width / im.height) / (w / h))) < 0.35:
                    base.alpha_composite(im.resize((w, h), Image.LANCZOS), (x, y))
                else:
                    part = _contain(im, w, h)
                    base.alpha_composite(part, (x + (w - part.width) // 2, y + (h - part.height) // 2))
        for p, r in layers:
            x, y, w, h = (round(W * r["x"] / 100), round(H * r["y"] / 100), round(W * r["w"] / 100), round(H * r["h"] / 100))
            with Image.open(p) as im:
                part = _contain(im.convert("RGBA"), w, h)
            base.alpha_composite(part, (x + (w - part.width) // 2, y + (h - part.height) // 2))
        if labels:  # 스텐실에 실물 이미지가 없는 PCIe 카드 → 해당 슬롯 위치에 라벨
            d = ImageDraw.Draw(base)
            for text, r in labels:
                x, y, w, h = (W * r["x"] / 100, H * r["y"] / 100, W * r["w"] / 100, H * r["h"] / 100)
                f = _font(max(11, int(min(h * 0.28, 28))))
                text_out = text
                while d.textlength(text_out, font=f) > w * 0.92 and len(text_out) > 6:
                    text_out = text_out[:-2].rstrip("…") + "…"
                tw = d.textlength(text_out, font=f)
                bh = f.size + 8 if hasattr(f, "size") else 18
                box = (x + 2, y + h / 2 - bh / 2, x + 2 + min(w - 4, tw + 12), y + h / 2 + bh / 2)
                d.rounded_rectangle(box, radius=3, fill=(16, 34, 56, 225))
                d.text((box[0] + 6, box[1] + 4), text_out, fill=(255, 255, 255, 255), font=f)
        if _annot_has(annot, view):
            base = _annotate_custom(base, server, view, annot, bp)
        elif caption is not None:
            base = _annotate(base, server, cfg, view, catalog, caption, bp)
        base.save(out)
        _cleanup()
    return {"url": "/static/renders/" + out.name, "missing": sorted(set(missing)),
            "labels": [t for t, _ in labels], "layers": len(layers)}


# =============================================================== 라벨 · 지시선
_CJK = ["C:/Windows/Fonts/malgun.ttf", "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/System/Library/Fonts/AppleSDGothicNeo.ttc"]
_LABEL_COLORS = {"nic": (47, 125, 225), "ocp": (224, 54, 75), "fc": (47, 165, 106), "gpu": (47, 165, 106),
                 "psu": (238, 138, 26), "boot": (242, 178, 26), "data": (70, 90, 120)}


def _label_font(px):
    for f in _CJK:
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            continue
    return _font(px)


def _slot_kind(comp: dict) -> str:
    cat = (comp.get("category") or "")
    return "ocp" if cat == "OCP NIC" else "fc" if cat == "FC HBA" else "gpu" if cat == "GPU" else "nic"


def _place(items: list[dict], d, font, width: int, pad: int, gap: int = 14):
    """라벨 상자를 가로 위치 순으로 놓되, 겹치면 다음 줄로 보낸다. items: {text, cx} → x, w, h, row 채움."""
    for it in items:
        it["w"] = round(d.textlength(it["text"], font=font)) + 20
        it["h"] = font.size + 12 if hasattr(font, "size") else 24
    rows: list[list[dict]] = []
    for it in sorted(items, key=lambda i: i["cx"]):
        x = min(max(pad, it["cx"] - it["w"] / 2), max(pad, width - pad - it["w"]))
        placed = False
        for ri, row in enumerate(rows):
            if x >= row[-1]["x"] + row[-1]["w"] + gap:
                it.update(x=x, row=ri); row.append(it); placed = True; break
        if not placed:
            it.update(x=x, row=len(rows)); rows.append([it])
    return len(rows)


def _annotate(base: Image.Image, server, cfg, view, catalog, labels: dict, bp) -> Image.Image:
    W, H = base.size
    size = max(15, round(W / 95))
    font = _label_font(size)
    probe = ImageDraw.Draw(base)
    top, bottom = [], []   # {text, cx, anchors:[(x,y)], color}
    boxes = []             # 앞면: 감싸는 사각형
    def ea(text, n):
        return f"{text} · {n} EA"
    if view == "rear":
        groups: dict[tuple, dict] = {}
        for slot in server["slots"]:
            cid = (cfg.get("slots") or {}).get(slot["id"])
            if not cid or cid not in catalog or not slot.get("hotspot"):
                continue
            comp = catalog[cid]
            info = (labels.get("slots") or {}).get(slot["id"]) or {}
            text = info.get("desc") if info.get("comp") == cid and info.get("desc") else comp["name"]
            kind = _slot_kind(comp)
            h = slot["hotspot"]
            g = groups.setdefault((kind, text), {"kind": kind, "text": text, "pts": [], "n": 0})
            g["pts"].append(((h["x"] + h["w"] / 2) / 100 * W, (h["y"] + h["h"] / 2) / 100 * H, h["y"] + h["h"] / 2 < 50)); g["n"] += 1
        n_psu = int(cfg.get("psu_count") or 0)
        psu_pts = [(p["hotspot"]["x"] + p["hotspot"]["w"] / 2, p["hotspot"]["y"] + p["hotspot"]["h"] / 2) for p in server.get("psu_slots", [])[:n_psu] if p.get("hotspot")]
        if psu_pts:
            watt = cfg.get("psu_watt")
            text = labels.get("psu") or f"PSU {watt:g}W" if isinstance(watt, (int, float)) else (labels.get("psu") or "PSU")
            groups[("psu", text)] = {"kind": "psu", "text": text, "n": len(psu_pts), "pts": [(x / 100 * W, y / 100 * H, False) for x, y in psu_pts]}
        for g in groups.values():
            up = sum(1 for p in g["pts"] if p[2]) * 2 >= len(g["pts"])
            item = {"text": ea(g["text"], g["n"]), "cx": sum(p[0] for p in g["pts"]) / len(g["pts"]),
                    "anchors": [(p[0], p[1]) for p in g["pts"]], "color": _LABEL_COLORS[g["kind"]]}
            (top if up else bottom).append(item)
    else:
        rects = bays(server, bp)["rects"]
        for role in ("boot", "data"):
            idx = [int(k) for k, b in (cfg.get("bays") or {}).items() if (b or {}).get("role") == role and int(k) < len(rects)]
            if not idx:
                continue
            descs: dict[str, int] = {}
            opts = {d["id"]: d["name"] for d in server.get("drive_options", [])}
            for k in idx:
                t = (labels.get("bays") or {}).get(str(k)) or opts.get(cfg["bays"][str(k)].get("drive"), "Disk")
                descs[t] = descs.get(t, 0) + 1
            x0 = min(rects[i]["x"] for i in idx) / 100 * W; x1 = max(rects[i]["x"] + rects[i]["w"] for i in idx) / 100 * W
            y0 = min(rects[i]["y"] for i in idx) / 100 * H; y1 = max(rects[i]["y"] + rects[i]["h"] for i in idx) / 100 * H
            text = " + ".join(ea(t, n) for t, n in descs.items())
            if role == "boot":
                text = "OS 설치 영역 · " + text
            boxes.append((x0, y0, x1, y1, _LABEL_COLORS[role]))
            bottom.append({"text": text, "cx": (x0 + x1) / 2, "anchors": [((x0 + x1) / 2, y1)], "color": _LABEL_COLORS[role]})
    pad = round(size * 0.8)
    nt = _place(top, probe, font, W, pad) if top else 0
    nb = _place(bottom, probe, font, W, pad) if bottom else 0
    rowh = (font.size + 12) + 14
    mt = nt * rowh + (24 if nt else 0)
    mb = nb * rowh + (24 if nb else 0)
    canvas = Image.new("RGBA", (W, H + mt + mb), (255, 255, 255, 255))
    canvas.alpha_composite(base, (0, mt))
    pen = ImageDraw.Draw(canvas, "RGBA")
    lw = max(2, round(size / 7))
    for x0, y0, x1, y1, col in boxes:
        pen.rectangle((x0, y0 + mt, x1, y1 + mt), outline=col + (255,), width=lw + 1)
    def draw(items, upper):
        for it in sorted(items, key=lambda i: i["row"]):
            row = it["row"]
            by = (mt - 12 - (row + 1) * rowh + 14) if upper else (mt + H + 12 + row * rowh)
            col = it["color"] + (255,)
            # 가까운 줄의 다른 라벨 밑을 지나지 않도록 연결 지점을 옮긴다
            near = [o for o in items if o["row"] < row]
            spots = [it["x"] + it["w"] / 2, it["x"] + 12, it["x"] + it["w"] - 12]
            bx = next((v for v in spots if not any(o["x"] - 6 <= v <= o["x"] + o["w"] + 6 for o in near)), None)
            if bx is None:   # 어디로 내려도 다른 라벨 밑을 지나면, 라벨을 옆으로 밀어 연결 지점을 비운다
                it["x"] = min(max(o["x"] + o["w"] for o in near) + 8 - 12, W - it["w"] - 4)
                bx = it["x"] + 12
            edge = (mt - 6 - row * 4) if upper else (mt + H + 6 + row * 4)
            pen.rounded_rectangle((it["x"], by, it["x"] + it["w"], by + it["h"]), radius=5, fill=(255, 255, 255, 255), outline=col, width=lw)
            pen.text((it["x"] + 10, by + 5), it["text"], fill=it["color"] + (255,), font=font)
            start = by + it["h"] if upper else by
            for ax, ay in it["anchors"]:
                ay = ay + mt
                pen.line([(bx, start), (bx, edge), (ax, edge), (ax, ay)], fill=col, width=lw, joint="curve")
                pen.ellipse((ax - lw * 2, ay - lw * 2, ax + lw * 2, ay + lw * 2), fill=col)
    draw(top, True)
    draw(bottom, False)
    return canvas


# =============================================================== 사용자가 편집한 라벨·연결선
def _annot_has(annot: dict | None, view: str) -> bool:
    return bool(annot and annot.get("show", True) and any(l.get("view") == view and not l.get("hidden") for l in annot.get("labels", [])))


def _annot_sig(annot: dict | None, view: str):
    if not _annot_has(annot, view):
        return None
    return json.dumps([[l for l in annot["labels"] if l.get("view") == view], [k for k in annot.get("links", []) if k.get("view") == view], "ca1"], sort_keys=True, default=str)


def _annotate_custom(base: Image.Image, server, view: str, annot: dict, bp) -> Image.Image:
    """화면(확대 창)에서 편집한 라벨 위치·연결선을 그대로 그린다. 위치는 그림 크기에 대한 %, 그림 밖도 가능."""
    W, H = base.size
    k = W / 1000.0                      # 화면에서 그림 폭을 약 1000px 로 보고 글자 크기를 환산
    labels = [l for l in annot.get("labels", []) if l.get("view") == view and not l.get("hidden")]
    by_id = {l["id"]: l for l in labels}
    if view == "front":
        rects = bays(server, bp)["rects"]
        targets = {("bay", str(i)): r for i, r in enumerate(rects)}
    else:
        targets = {("slot", sl["id"]): sl["hotspot"] for sl in [*server.get("slots", []), *server.get("psu_slots", [])] if sl.get("hotspot")}
    probe = ImageDraw.Draw(base)
    boxes = {}
    for l in labels:
        font = _label_font(max(10, round((l.get("size") or 13) * k)))
        tw = probe.textlength(l.get("text") or "(빈 라벨)", font=font)
        bw, bh = tw + 20 * k, font.size + 12 * k if hasattr(font, "size") else 24
        cx, cy = l["x"] / 100 * W, l["y"] / 100 * H
        boxes[l["id"]] = (cx - bw / 2, cy - bh / 2, bw, bh, font)
    pad = 12 * k
    top = max([0] + [-(b[1]) + pad for b in boxes.values()])
    bottom = max([0] + [b[1] + b[3] + pad - H for b in boxes.values()])
    canvas = Image.new("RGBA", (W, int(H + top + bottom)), (255, 255, 255, 255))
    canvas.alpha_composite(base, (0, int(top)))
    pen = ImageDraw.Draw(canvas, "RGBA")

    def color(c, default=(47, 125, 225)):
        c = (c or "").lstrip("#")
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) if len(c) == 6 else default

    def edge(r):
        return [(r[0] + r[2] / 2, r[1], "t"), (r[0] + r[2] / 2, r[1] + r[3], "b"), (r[0], r[1] + r[3] / 2, "l"), (r[0] + r[2], r[1] + r[3] / 2, "r")]
    for link in annot.get("links", []):
        if link.get("view") != view or link.get("hidden") or link.get("from") not in by_id:
            continue
        rect = targets.get((link["to"].get("kind"), str(link["to"].get("id"))))
        if not rect:
            continue
        lb = boxes[link["from"]]
        tbox = (rect["x"] / 100 * W, rect["y"] / 100 * H, rect["w"] / 100 * W, rect["h"] / 100 * H)
        tc = (tbox[0] + tbox[2] / 2, tbox[1] + tbox[3] / 2)
        a = min(edge(lb[:4]), key=lambda p: math.hypot(p[0] - tc[0], p[1] - tc[1]))
        b = min(edge(tbox), key=lambda p: math.hypot(p[0] - a[0], p[1] - a[1]))
        if link.get("elbow", True):
            if a[2] in ("t", "b"):
                mid = (a[1] + b[1]) / 2; pts = [(a[0], a[1]), (a[0], mid), (b[0], mid), (b[0], b[1])]
            else:
                mid = (a[0] + b[0]) / 2; pts = [(a[0], a[1]), (mid, a[1]), (mid, b[1]), (b[0], b[1])]
        else:
            pts = [(a[0], a[1]), (b[0], b[1])]
        pts = [(x, y + top) for x, y in pts]
        col = color(link.get("color")) + (255,)
        lw = max(2, round((link.get("width") or 2) * k))
        for p, q in zip(pts, pts[1:]):
            if link.get("dash"):
                length = math.hypot(q[0] - p[0], q[1] - p[1]); n = max(1, int(length / (9 * k)))
                for i in range(0, n, 2):
                    t0, t1 = i / n, min(1, (i + 1) / n)
                    pen.line([(p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0), (p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1)], fill=col, width=lw)
            else:
                pen.line([p, q], fill=col, width=lw)
        def arrow(tip, frm):
            ang = math.atan2(tip[1] - frm[1], tip[0] - frm[0]); size = 9 * k
            pen.polygon([tip, (tip[0] - size * math.cos(ang - .4), tip[1] - size * math.sin(ang - .4)), (tip[0] - size * math.cos(ang + .4), tip[1] - size * math.sin(ang + .4))], fill=col)
        if link.get("arrowEnd"): arrow(pts[-1], pts[-2])
        else: pen.ellipse((pts[-1][0] - lw * 1.6, pts[-1][1] - lw * 1.6, pts[-1][0] + lw * 1.6, pts[-1][1] + lw * 1.6), fill=col)
        if link.get("arrowStart"): arrow(pts[0], pts[1])
    for l in labels:
        x, y, w, h, font = boxes[l["id"]]
        col = color(l.get("color")) + (255,)
        pen.rounded_rectangle((x, y + top, x + w, y + top + h), radius=5 * k, fill=(255, 255, 255, 255), outline=col, width=max(2, round(1.5 * k)))
        bold = round(k * 0.7) if l.get("bold") else 0     # 굵은 글꼴이 없어도 굵게 보이게 테두리를 덧그린다
        pen.text((x + 10 * k, y + top + 6 * k), l.get("text") or "(빈 라벨)", fill=col, font=font, stroke_width=bold, stroke_fill=col)
    return canvas


def _cleanup(keep=300):
    fs = sorted(RENDERS.glob("*.png"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in fs[keep:]:
        f.unlink(missing_ok=True)
