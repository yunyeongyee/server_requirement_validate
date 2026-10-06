# VSSX/VSDX 분석 및 이미지 추출
"""Visio VSSX/VSDX → 마스터(쉐이프)별 실제 이미지 PNG 렌더링.

Dell 스텐실의 마스터는 Group 이며, 그 안의 Foreign 쉐이프(EMF)들이 실제 제품 이미지 조각이다.
각 Foreign 의 위치/크기(인치)를 읽어 하나의 PNG 로 합성하고, 마스터 전체 크기(인치)도 함께 기록한다.
→ 서버 전면/후면, 디스크, OCP, 블랭크 등이 모두 '실제 스케일'로 정렬된다.

EMF 래스터화
  - Windows : Pillow 가 GDI 로 EMF 를 직접 렌더 (LibreOffice 불필요, 빠름)
  - 그 외   : LibreOffice(EMF→PDF, 일괄 변환) → pypdfium2(PDF→PNG, 고해상도) → 내용 영역 정확히 잘라냄
"""
from __future__ import annotations
import math, os, platform, re, shutil, struct, subprocess, tempfile, zipfile
from dataclasses import dataclass, field
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image

NS = "{http://schemas.microsoft.com/office/visio/2012/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"
PPI = 150  # 렌더 해상도 (픽셀/인치). 19" 서버 → 약 2850px


# ------------------------------------------------------------------ 분류
def classify(name: str) -> str:
    n = name.lower()
    if re.search(r"\bfront\b", n) and re.search(r"^(r|hs|c|xr|xe|t|mx)\d", n): return "server_front"
    if re.search(r"\brear\b", n) and re.search(r"^(r|hs|c|xr|xe|t|mx)\d", n): return "server_rear"
    if "ocp" in n and "filler" not in n: return "ocp"
    if re.search(r"\b(2\.5|3\.5)\b.*(sas|sata|ssd|nvme|nlsas)|e3\.s (ssd|drive)", n): return "drive"
    if re.search(r"filler|blank", n): return "blank"
    if re.search(r"psu", n): return "psu"
    if re.search(r"riser", n): return "riser"
    if re.search(r"bezel", n): return "bezel"
    if re.search(r"ndc|lom|boss|m\.2", n): return "module"
    return "other"


# ------------------------------------------------------------------ 패키지 해석
def _rels(z: zipfile.ZipFile, path: str) -> dict[str, str]:
    try:
        return {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read(path)).iter(PKG)}
    except KeyError:
        return {}


def _norm(base: str, target: str) -> str:
    out = []
    for p in (base + "/" + target).split("/"):
        if p == "..":
            out and out.pop()
        elif p and p != ".":
            out.append(p)
    return "/".join(out)


def _cell(s, n, default=0.0) -> float:
    c = s.find(f"{NS}Cell[@N='{n}']")
    try:
        return float(c.get("V")) if c is not None else default
    except (TypeError, ValueError):
        return default


@dataclass
class Piece:
    media: str          # zip 내부 경로
    x: float; y: float; w: float; h: float   # 마스터 로컬 좌표(인치, y 위쪽+), 좌하단 기준
    angle: float = 0.0


@dataclass
class Master:
    name: str
    pieces: list[Piece] = field(default_factory=list)
    angle: float = 0.0
    category: str = ""


def read_masters(path: Path) -> tuple[list[Master], zipfile.ZipFile]:
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    mrels = _rels(z, "visio/masters/_rels/masters.xml.rels")
    root = ET.fromstring(z.read("visio/masters/masters.xml"))
    # VSDX 는 마스터 이름이 페이지 쉐이프 쪽에만 제대로 있는 경우가 있어 보완
    page_names = _page_master_names(z)
    out = []
    for m in root.findall(f"{NS}Master"):
        rel = m.find(f"{NS}Rel")
        if rel is None or rel.get(RNS) not in mrels:
            continue
        mfile = _norm("visio/masters", mrels[rel.get(RNS)])
        name = m.get("NameU") or m.get("Name") or ""
        if (not name or re.fullmatch(r"\d+", name)) and m.get("ID") in page_names:
            name = page_names[m.get("ID")]
        media_rels = _rels(z, f"visio/masters/_rels/{Path(mfile).name}.rels")
        mx = ET.fromstring(z.read(mfile))
        shapes = mx.find(f"{NS}Shapes")
        if shapes is None:
            continue
        master = Master(name=name, category=classify(name))
        for top in shapes:
            master.angle = _cell(top, "Angle")
            _walk(top, 0.0, 0.0, media_rels, names, master, top_level=True)
        if master.pieces:
            out.append(master)
    return out, z


def _walk(s, ox, oy, media_rels, names, master: Master, top_level=False):
    """Group 내부를 재귀로 돌며 Foreign(이미지) 조각의 마스터 로컬 좌표를 수집."""
    if s.get("Type") == "Foreign":
        fd = s.find(f"{NS}ForeignData")
        rel = fd.find(f"{NS}Rel") if fd is not None else None
        if rel is not None and rel.get(RNS) in media_rels:
            mp = _norm("visio/masters", media_rels[rel.get(RNS)])
            if mp in names:
                w, h = _cell(s, "Width"), _cell(s, "Height")
                x = ox + _cell(s, "PinX") - _cell(s, "LocPinX", w / 2)
                y = oy + _cell(s, "PinY") - _cell(s, "LocPinY", h / 2)
                if w > 0 and h > 0:
                    master.pieces.append(Piece(mp, x, y, w, h, _cell(s, "Angle")))
        return
    sub = s.find(f"{NS}Shapes")
    if sub is None:
        return
    if top_level:
        cx, cy = ox, oy   # 최상위 그룹의 자식은 그룹 로컬 좌표
    else:
        w, h = _cell(s, "Width"), _cell(s, "Height")
        cx = ox + _cell(s, "PinX") - _cell(s, "LocPinX", w / 2)
        cy = oy + _cell(s, "PinY") - _cell(s, "LocPinY", h / 2)
    for c in sub:
        _walk(c, cx, cy, media_rels, names, master)


def _page_master_names(z: zipfile.ZipFile) -> dict[str, str]:
    out = {}
    for p in [n for n in z.namelist() if re.match(r"visio/pages/page\d+\.xml$", n)]:
        try:
            r = ET.fromstring(z.read(p))
        except ET.ParseError:
            continue
        for s in r.iter(f"{NS}Shape"):
            if s.get("Master") and s.get("NameU") and not re.fullmatch(r"\d+", s.get("NameU")):
                out.setdefault(s.get("Master"), re.sub(r"\.\d+$", "", s.get("NameU")))
    return out


# ------------------------------------------------------------------ EMF 래스터화
def find_soffice() -> str | None:
    p = shutil.which("soffice") or shutil.which("libreoffice")
    if p:
        return p
    for c in (r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
              "/Applications/LibreOffice.app/Contents/MacOS/soffice"):
        if os.path.exists(c):
            return c
    return None


IS_WINDOWS = platform.system() == "Windows"


def _emf_aspect(data: bytes) -> float | None:
    try:
        l, t, r, b = struct.unpack("<4i", data[24:40])   # rclFrame (0.01mm)
        return (r - l) / (b - t) if b != t else None
    except struct.error:
        return None


class Rasterizer:
    """EMF 파일들을 PNG(Image) 로. 모든 EMF 를 한 번에 PDF 로 변환해 두고 필요할 때 렌더."""

    def __init__(self, z: zipfile.ZipFile, media: list[str], progress=None):
        self.z, self.cache, self.progress = z, {}, progress or (lambda *a: None)
        self.tmp = Path(tempfile.mkdtemp(prefix="emf_"))
        self.files: dict[str, Path] = {}
        for i, m in enumerate(sorted(set(media))):
            p = self.tmp / f"m{i}{Path(m).suffix.lower()}"
            p.write_bytes(z.read(m))
            self.files[m] = p
        self.mode = "pillow" if IS_WINDOWS else "soffice"
        if self.mode == "soffice":
            self._batch_pdf()

    def _batch_pdf(self):
        soffice = find_soffice()
        if not soffice:
            raise RuntimeError("EMF 변환에 LibreOffice가 필요합니다 (soffice 를 찾을 수 없음)")
        vec = [p for p in self.files.values() if p.suffix in (".emf", ".wmf")]
        for attempt in range(4):   # LibreOffice 가 일괄 변환 중 멈추는 경우가 있어 남은 것만 재시도
            todo = [p for p in vec if not p.with_suffix(".pdf").exists()]
            if not todo:
                break
            self.progress("convert", len(vec) - len(todo), len(vec))
            for i in range(0, len(todo), 60):
                subprocess.run([soffice, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(self.tmp)]
                               + [str(p) for p in todo[i:i + 60]],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
                self.progress("convert", len(vec) - len([p for p in vec if not p.with_suffix(".pdf").exists()]), len(vec))

    def image(self, media: str, w_in: float, h_in: float) -> Image.Image | None:
        key = (media, round(w_in, 3), round(h_in, 3))
        if key in self.cache:
            return self.cache[key]
        p = self.files[media]
        W, H = max(1, round(w_in * PPI)), max(1, round(h_in * PPI))
        im = None
        try:
            if p.suffix not in (".emf", ".wmf"):
                im = Image.open(p).convert("RGBA")
            elif self.mode == "pillow":
                im = Image.open(p)
                im.load(dpi=max(96, int(PPI * max(W / max(im.width, 1), 1))))
                im = im.convert("RGBA")
            else:
                im = self._from_pdf(p, W, H)
        except Exception:
            im = None
        if im is not None:
            im = im.resize((W, H), Image.LANCZOS)
        self.cache[key] = im
        return im

    def _from_pdf(self, p: Path, W: int, H: int) -> Image.Image | None:
        import pypdfium2 as pdfium
        pdf_p = p.with_suffix(".pdf")
        if not pdf_p.exists():
            return None
        pdf = pdfium.PdfDocument(str(pdf_p))
        page = pdf[0]
        pw, ph = page.get_size()                 # pt
        aspect = _emf_aspect(p.read_bytes()[:64]) or (W / H)
        margin = 28.3465                         # LibreOffice Draw 기본 여백 1cm
        aw, ah = pw - 2 * margin, ph - 2 * margin
        cw, ch = (aw, aw / aspect) if aspect >= aw / ah else (ah * aspect, ah)
        cx, cy = (pw - cw) / 2, (ph - ch) / 2
        scale = max(W / cw, H / ch, 1.0)
        bmp = page.render(scale=scale).to_pil().convert("RGBA")
        box = (round(cx * scale), round(cy * scale), round((cx + cw) * scale), round((cy + ch) * scale))
        pdf.close()
        return bmp.crop(box)

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


# ------------------------------------------------------------------ 마스터 합성
def render_master(m: Master, r: Rasterizer) -> tuple[Image.Image, float, float] | None:
    xs = [p.x for p in m.pieces] + [p.x + p.w for p in m.pieces]
    ys = [p.y for p in m.pieces] + [p.y + p.h for p in m.pieces]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w_in, h_in = maxx - minx, maxy - miny
    if w_in <= 0 or h_in <= 0:
        return None
    canvas = Image.new("RGBA", (max(1, round(w_in * PPI)), max(1, round(h_in * PPI))), (0, 0, 0, 0))
    ok = False
    # 큰 조각(본체)부터 그리고 작은 조각(라벨, LED 등)을 위에
    for p in sorted(m.pieces, key=lambda p: -p.w * p.h):
        im = r.image(p.media, p.w, p.h)
        if im is None:
            continue
        if abs(p.angle) > 1e-3:
            im = im.rotate(math.degrees(p.angle), expand=True)
        x = round((p.x - minx) * PPI)
        y = round((maxy - (p.y + p.h)) * PPI)     # Visio y↑ → 이미지 y↓
        canvas.alpha_composite(im, (max(0, x), max(0, y)))
        ok = True
    if not ok:
        return None
    if abs(m.angle) > 1e-3:
        canvas = canvas.rotate(math.degrees(m.angle), expand=True)
        if round(abs(math.degrees(m.angle))) % 180 == 90:
            w_in, h_in = h_in, w_in
    return canvas, w_in, h_in


def extract(path: Path, out_dir: Path, progress=None, only=None) -> list[dict]:
    """스텐실/도면의 모든 마스터를 PNG 로. 반환: [{name, category, file, w_in, h_in}]"""
    progress = progress or (lambda *a: None)
    masters, z = read_masters(path)
    if only:
        masters = [m for m in masters if only(m)]
    progress("parse", len(masters), len(masters))
    media = [p.media for m in masters for p in m.pieces]
    r = Rasterizer(z, media, progress)
    out_dir.mkdir(parents=True, exist_ok=True)
    items = []
    try:
        for i, m in enumerate(masters):
            progress("render", i, len(masters))
            res = render_master(m, r)
            if not res:
                items.append({"name": m.name, "category": m.category, "file": None, "error": "이미지 변환 실패"})
                continue
            img, w_in, h_in = res
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", m.name)[:70] or "shape"
            f = out_dir / f"{safe}_{abs(hash((path.name, m.name))) % 10**8}.png"
            img.save(f)
            items.append({"name": m.name, "category": m.category, "file": f, "w_in": round(w_in, 4), "h_in": round(h_in, 4),
                          "px": img.size})
        progress("render", len(masters), len(masters))
    finally:
        r.close(); z.close()
    return items


if __name__ == "__main__":
    import sys, time
    t = time.time()
    pat = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
    res = extract(Path(sys.argv[1]), Path("/tmp/visio_out"), lambda s, a, b: print(s, a, b, end="\r"),
                  only=(lambda m: pat.search(m.name)) if pat else None)
    print()
    for it in res:
        print(it["category"], it["name"], it.get("w_in"), it.get("h_in"), it.get("px"), it.get("error", ""))
    print(f"{time.time() - t:.1f}s")
