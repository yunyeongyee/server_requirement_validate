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
import hashlib, io, json, re, threading, time, traceback, uuid
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import visio

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "static" / "images" / "library"
RENDERS = ROOT / "static" / "renders"
MANIFEST = LIB / "manifest.json"
MAPFILE = ROOT / "data" / "image_map.json"
for d in (LIB, RENDERS):
    d.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()


# =============================================================== 라이브러리
def library() -> list[dict]:
    with _lock:
        return json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else []


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
        m = json.loads(MAPFILE.read_text(encoding="utf-8")) if MAPFILE.exists() else {}
    m.setdefault("servers", {}); m.setdefault("components", {}); m.setdefault("drives", {})
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
    return by_name(bp.get("stencil") if bp else None), True


def rear_item(server) -> tuple[dict | None, bool]:
    ov = _map()["servers"].get(server["id"], {}).get("rear")
    if ov and item(ov):
        return item(ov), False
    return by_name(server.get("rear_stencil")), True


def comp_item(comp: dict) -> tuple[dict | None, bool]:
    ov = _map()["components"].get(comp["id"])
    if ov and item(ov):
        return item(ov), False
    return by_name(comp.get("stencil")), True


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
DRIVE_FACE = {"2.5": [(0.603, 2.853), (2.853, 0.603)], "3.5": [(4.103, 1.028)]}


def _runs(mask) -> list[tuple[int, int]]:
    out, s = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append((s, i)); s = None
    return out


def detect_bays(path: Path, ff: str, count: int, ppi_x: float, fill: bool = True) -> tuple[list[dict], bool]:
    """전면 이미지에서 밝은 구분선 사이의 어두운 영역 중 드라이브 크기와 맞는 칸을 베이로 인식."""
    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(int)
    H, W = a.shape
    sizes = [(w * ppi_x, h * ppi_x) for w, h in DRIVE_FACE[ff]]
    best = []
    for light in (215, 200, 230):
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
    if saved and saved.get("item") == fi["id"] and not force:
        return saved
    p = ROOT / "static" / fi["file"]
    ppi = Image.open(p).width / fi["w_in"] if fi.get("w_in") else visio.PPI
    rects, ok = detect_bays(p, bp["ff"], bp["bays"], ppi)
    if not rects:  # 감지 실패 → 보정용 기본 배치
        n = bp["bays"]
        rects = [{"x": 5 + i * 85 / n, "y": 10, "w": 85 / n * 0.9, "h": 80} for i in range(n)]
    saved = {"item": fi["id"], "rects": rects, "ok": ok, "source": "auto"}
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
    return {"front": {"item": _brief(fi), "auto": fa, "stencil": bp.get("stencil")},
            "rear": {"item": _brief(ri), "auto": ra, "stencil": server.get("rear_stencil")},
            "bays": {**by, "candidates": bay_candidates(server, bp)}, "components": comp_imgs, "drives": drv, "library_count": len(library())}


# =============================================================== 합성
def _contain(img: Image.Image, w: int, h: int) -> Image.Image:
    """방향이 다르면 90° 회전 후, 비율 유지하며 영역 안에 맞춤."""
    if (img.width > img.height) != (w > h) and abs(img.width - img.height) > 3:
        img = img.rotate(90, expand=True)
    s = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _font(px):
    try:
        return ImageFont.load_default(size=px)
    except TypeError:
        return ImageFont.load_default()


def render(server, cfg, view, catalog: dict) -> dict:
    if view == "front":
        bp = next((b for b in server["backplanes"] if b["id"] == cfg.get("backplane")), server["backplanes"][0])
        base_it, _ = front_item(server, bp["id"])
    else:
        bp = None
        base_it, _ = rear_item(server)
    if not base_it:
        return {"url": None, "reason": "이미지 미지정"}
    base_p = ROOT / "static" / base_it["file"]
    layers, labels, missing = [], [], []
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
    else:
        for slot in server["slots"]:
            cid = (cfg.get("slots") or {}).get(slot["id"])
            if not cid or cid not in catalog:
                continue
            it, _ = comp_item(catalog[cid])
            if it:
                layers.append((ROOT / "static" / it["file"], slot["hotspot"]))
            else:
                labels.append((catalog[cid].get("short") or catalog[cid]["name"], slot["hotspot"]))
    sig = json.dumps([base_it["id"], base_p.stat().st_mtime,
                      [(str(p), p.stat().st_mtime, r) for p, r in layers], labels], sort_keys=True, default=str)
    out = RENDERS / f"{server['id']}_{view}_{hashlib.sha1(sig.encode()).hexdigest()[:16]}.png"
    if not out.exists():
        with Image.open(base_p) as b:
            base = b.convert("RGBA")
        W, H = base.size
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
        base.save(out)
        _cleanup()
    return {"url": "/static/renders/" + out.name, "missing": sorted(set(missing)),
            "labels": [t for t, _ in labels], "layers": len(layers)}


def _cleanup(keep=300):
    fs = sorted(RENDERS.glob("*.png"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in fs[keep:]:
        f.unlink(missing_ok=True)
