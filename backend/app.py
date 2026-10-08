
# API Endpoint / 서버 실행
import asyncio, json, logging
from pathlib import Path
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import doc_tables, extract, images, parts, paste as P, proposal, validate as V
P.load_env()  # .env 의 API 키·설정을 환경변수로

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATIC = ROOT / "static"

app = FastAPI(title="Server Requirement Validator")
logger = logging.getLogger(__name__)


def load_servers() -> dict:
    return json.loads((DATA / "servers.json").read_text(encoding="utf-8"))


def save_servers(d: dict):
    path = DATA / "servers.json"
    crlf = b"\r\n" in path.read_bytes()[:200]  # 원래 줄바꿈 형식을 유지해 불필요한 diff를 만들지 않는다
    text = json.dumps(d, ensure_ascii=False, indent=2) + "\n"
    path.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode("utf-8"))


def catalog() -> dict:
    comps = json.loads((DATA / "components.json").read_text(encoding="utf-8"))["components"]
    return {c["id"]: c for c in comps}


def server_by_id(sid: str) -> dict:
    s = next((s for s in load_servers()["servers"] if s["id"] == sid), None)
    if not s:
        raise HTTPException(404, f"server {sid} not found")
    return s


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/version")
def version():
    return {"version": "v4"}


@app.get("/api/ai/status")
def ai_status():
    return P.status()


@app.post("/api/ai/check")
async def ai_check():
    return {**P.status(), **(await asyncio.to_thread(P.check_connection))}


@app.get("/api/servers")
def servers():
    return load_servers()


@app.get("/api/components")
def components():
    return list(catalog().values())


# ------------------------------------------------ 요구사항 붙여넣기
def _suggest(group: dict, text: str):
    """그룹(또는 붙여넣은 글 전체)에서 모델명(R760 등)을 찾아 추천 모델로 붙인다."""
    if group.get("suggested_server"):
        return
    own = " ".join([group.get("name", ""), group.get("model_hint") or "", group.get("base_desc") or ""]
                   + [r.get("source", "") for r in group.get("requirements", [])])
    hint = group.get("model_hint") or parts.model_of(own) or parts.model_of(text)
    if hint:
        group["model_hint"] = hint
        group["suggested_server"] = proposal.suggest_server(hint, load_servers()["servers"])


class PasteIn(BaseModel):
    text: str
    kind: str = "requirement"  # requirement(왼쪽 칸) | quote(오른쪽 칸)
    ai: bool = False           # 화면의 'AI 분석' 토글
    rule_lines: list[int] = []  # AI 와 규칙이 다른 줄에서 사용자가 '규칙 값'을 고른 줄


@app.post("/api/paste")
def paste(body: PasteIn):
    """긁어 붙인 요구사항 문장·견적 표 → 서버 1대 분석 + 줄마다 결과 + (여러 서버가 보이면) 나누기 제안.
    탭(또는 2칸 이상 공백)은 표의 칸으로 읽는다. 외부 전송 없음."""
    text = body.text.replace("\r\n", "\n").strip("\n")
    if not text.strip():
        raise HTTPException(422, "붙여넣은 내용이 없습니다")
    result = P.analyze(text, _suggest, body.kind, body.ai, body.rule_lines)
    if result.get("error"):
        raise HTTPException(422, result["error"])
    return result


class ProposalIn(BaseModel):
    server_id: str
    proposed: dict
    base_config: dict
    backplane_hint: dict | None = None


@app.post("/api/proposal/apply")
def apply_proposal(body: ProposalIn):
    """견적서 제안 구성 → 선택한 모델의 서버 구성(배치 제안 + 옮기지 못한 항목 안내)."""
    return proposal.to_config(server_by_id(body.server_id), body.proposed, catalog(), body.base_config, body.backplane_hint)


# ------------------------------------------------ 검증
class ValidateIn(BaseModel):
    server_id: str
    config: dict
    requirements: list[dict]


@app.post("/api/validate")
def validate(body: ValidateIn):
    return V.validate(server_by_id(body.server_id), body.config, body.requirements, catalog())


# ------------------------------------------------ 이미지 라이브러리 (VSSX/VSDX/PNG)
@app.get("/api/library")
def get_library():
    return {"items": [i for i in images.library() if i.get("file")]}


@app.post("/api/library")
async def add_library(files: list[UploadFile] = File(...)):
    payload = [(f.filename, await f.read()) for f in files]
    for name, _ in payload:
        if Path(name).suffix.lower() not in (".vssx", ".vsdx", ".vstx", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
            raise HTTPException(400, f"지원하지 않는 형식: {name}")
    return {"job": images.start_ingest(payload)}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = images.JOBS.get(jid)
    if not j:
        raise HTTPException(404)
    return j


@app.delete("/api/library/{item_id}")
def delete_library(item_id: str):
    images.delete_item(item_id); return {"ok": True}


# ------------------------------------------------ 이미지 매핑 / 베이 / 합성
@app.get("/api/images/{sid}")
def image_status(sid: str, backplane: str):
    server = server_by_id(sid)
    try:
        return images.status(server, list(catalog().values()), backplane)
    except Exception as error:  # 원인을 화면에 보여준다 (그냥 HTTP 500 이 아니라)
        logger.exception("image status failed")
        raise HTTPException(500, f"서버 그림을 불러오지 못했습니다: {type(error).__name__}: {error}") from error


class MapIn(BaseModel):
    kind: str            # front | rear | component | drive | psu
    key: str = ""        # front: backplane id, component: component id, drive: "<drive_id>:<V|H>"
    item_id: str | None = None


@app.put("/api/images/{sid}/map")
def set_map(sid: str, body: MapIn):
    server_by_id(sid)
    try:
        images.set_map(sid, body.kind, body.key, body.item_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


class BaysIn(BaseModel):
    rects: list[dict]


@app.put("/api/images/{sid}/bays/{bp}")
def save_bays(sid: str, bp: str, body: BaysIn):
    images.save_bays(server_by_id(sid), bp, body.rects); return {"ok": True}


@app.post("/api/images/{sid}/bays/{bp}/detect")
def redetect(sid: str, bp: str):
    s = server_by_id(sid)
    b = next((x for x in s["backplanes"] if x["id"] == bp), None)
    if not b:
        raise HTTPException(404)
    return images.bays(s, b, force=True)


class HotspotIn(BaseModel):
    hotspots: dict


@app.put("/api/servers/{sid}/hotspots")
def save_hotspots(sid: str, body: HotspotIn):
    data = load_servers()
    s = next((s for s in data["servers"] if s["id"] == sid), None)
    if not s:
        raise HTTPException(404)
    for slot in s["slots"] + s.get("psu_slots", []):
        if slot["id"] in body.hotspots:
            slot["hotspot"] = {k: round(float(v), 2) for k, v in body.hotspots[slot["id"]].items()}
    # 사용할 수 없는 영역(blk:0, blk:1 …): 보낸 목록으로 통째로 바꾼다 (추가·삭제 반영)
    blocked = [(int(k.split(":")[1]), v) for k, v in body.hotspots.items() if k.startswith("blk:")]
    if blocked or "rear_blocked" in s:
        old = s.get("rear_blocked", [])
        s["rear_blocked"] = [{**{key: round(float(v[key]), 2) for key in ("x", "y", "w", "h")},
                              "reason": v.get("reason") or (old[i]["reason"] if i < len(old) else "이 모델 데이터에 없는 영역이라 사용할 수 없습니다")}
                             for i, v in sorted(blocked)]
    save_servers(data)
    return {"ok": True}


class RenderIn(BaseModel):
    server_id: str
    view: str
    config: dict
    labels: dict | None = None   # 있으면 견적 품명 라벨·지시선을 그린다 (제안서용)


@app.post("/api/render")
async def render(body: RenderIn):
    if body.view not in ("front", "rear"):
        raise HTTPException(400)
    return await asyncio.to_thread(images.render, server_by_id(body.server_id), body.config, body.view, catalog(), body.labels)


app.mount("/static", StaticFiles(directory=STATIC), name="static")
