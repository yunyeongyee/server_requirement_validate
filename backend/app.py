
# API Endpoint / 서버 실행
import asyncio, json, logging
from pathlib import Path
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai_extract, doc_tables, extract, images, parts, proposal, validate as V

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATIC = ROOT / "static"
DOC_TYPES = {".pdf", ".docx", ".xlsx", ".xlsm", ".txt", ".csv", ".json"}

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


@app.get("/api/servers")
def servers():
    return load_servers()


@app.get("/api/components")
def components():
    return list(catalog().values())


# ------------------------------------------------ 요구사항 문서
def _analyze_requirements(text: str, context: dict | None = None, ai_allowed: bool = True) -> dict:
    rule_groups = extract.extract_server_groups(text)
    if ai_allowed:
        groups, extraction_info = ai_extract.extract_groups(text, context, rule_groups)
    else:
        groups = rule_groups
        extraction_info = {"mode": "rules_fallback", "effort": None}
    _suggest_models(groups, text)
    return {
        "requirements": extract.extract_requirements(text),
        "spec": extract.spec_summary(text),
        "groups": groups,
        "extraction": extraction_info,
    }


def _suggest_models(groups: list[dict], text: str):
    """요구사항 문서에서도 모델명(R760 등)을 찾아 그룹별 추천 모델로 붙인다. 그룹 안 → 문서 전체 순."""
    servers_list = load_servers()["servers"]
    doc_hint = parts.model_of(text)
    for g in groups:
        if g.get("suggested_server"):
            continue
        own = " ".join([g.get("name", "")] + [r.get("source", "") for r in g.get("requirements", [])])
        hint = g.get("model_hint") or parts.model_of(own) or doc_hint
        if hint:
            g["model_hint"] = hint
            g["suggested_server"] = proposal.suggest_server(hint, servers_list)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in DOC_TYPES:
        raise HTTPException(400, f"지원 형식: {', '.join(sorted(DOC_TYPES))}")
    data = await file.read()
    try:
        text = extract.extract_text(file.filename, data)
    except Exception as e:
        raise HTTPException(422, f"본문 추출 실패: {e}")
    if not text.strip():
        raise HTTPException(422, "본문 텍스트가 없습니다 (스캔 PDF라면 OCR 필요)")
    # 1) 양식 무관 구조 해석(표·시트·서버 그룹·견적 여부) — 규칙만 사용, 외부 전송 없음
    try:
        doc = await asyncio.to_thread(doc_tables.analyze_document, file.filename, data, text)
    except Exception:
        logger.exception("document structure analysis failed")
        doc = None
    if doc and doc["groups"] and (doc["doc_role"] == "quote" or len(doc["groups"]) > 1 or not ai_extract.enabled()):
        servers_list = load_servers()["servers"]
        for g in doc["groups"]:
            g["suggested_server"] = proposal.suggest_server(g.get("model_hint"), servers_list)
        _suggest_models(doc["groups"], text)
        return {"filename": file.filename, "chars": len(text), "text": text,
                "requirements": [], "spec": [], "groups": doc["groups"], "doc_role": doc["doc_role"],
                "common_items": doc["common_items"], "inventory": doc.get("inventory", []),
                "extraction": {"mode": "rules", "effort": None}}
    context = None
    context_error = None
    if ai_extract.enabled():
        try:
            context = await asyncio.to_thread(extract.extract_document_context, file.filename, data)
        except Exception:
            logger.exception("Could not preserve document structure for AI extraction")
            context_error = "문서 표/시트 맥락 추출에 실패해 평문 규칙 결과를 사용했습니다."
    result = await asyncio.to_thread(_analyze_requirements, text, context, not bool(context_error))
    if context_error:
        context_error = f"{context_error} 원문을 확인하세요."
        result["extraction"] = {
            "mode": "rules_fallback",
            "effort": None,
            "notice": context_error,
        }
    return {"filename": file.filename, "chars": len(text), "text": text, **result}


class ProposalIn(BaseModel):
    server_id: str
    proposed: dict
    base_config: dict
    backplane_hint: dict | None = None


@app.post("/api/proposal/apply")
def apply_proposal(body: ProposalIn):
    """견적서 제안 구성 → 선택한 모델의 서버 구성(배치 제안 + 옮기지 못한 항목 안내)."""
    return proposal.to_config(server_by_id(body.server_id), body.proposed, catalog(), body.base_config, body.backplane_hint)


class TextIn(BaseModel):
    text: str


@app.post("/api/extract")
def extract_from_text(body: TextIn):
    return _analyze_requirements(body.text)


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
    return images.status(server_by_id(sid), list(catalog().values()), backplane)


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
    save_servers(data)
    return {"ok": True}


class RenderIn(BaseModel):
    server_id: str
    view: str
    config: dict


@app.post("/api/render")
async def render(body: RenderIn):
    if body.view not in ("front", "rear"):
        raise HTTPException(400)
    return await asyncio.to_thread(images.render, server_by_id(body.server_id), body.config, body.view, catalog())


app.mount("/static", StaticFiles(directory=STATIC), name="static")
