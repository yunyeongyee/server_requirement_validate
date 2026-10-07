"""붙여넣은 글 → 서버 1대 분석 + 줄마다 무엇으로 읽었는지.

모든 줄은 다음 중 하나로 표시된다 (조용히 빠지는 줄이 없게):
  req  : 요구사항으로 읽음 (requirement.line 이 이 줄)
  part : 견적 품목으로 읽음 (오른쪽 구성에 반영)
  skip : 견적 부속품·라이선스 등 검증 대상 아님
  head : 서버 제목 줄
  warn : 읽지 못함 → 사용자가 직접 정한다
외부 전송 없음.
"""
from __future__ import annotations
import re

from . import doc_tables, extract, parts

SKIP_CATEGORIES = {"accessory", "license", "transceiver"}
# 숫자 없는 짧은 제목 줄 ("서버 요구사항", "[하드웨어 사양]")
HEADING = re.compile(r"^[\[(<【]?\s*(?:\d+[.)]\s*)?[^\d]{0,20}(?:요구\s*사항|요구\s*사양|사양|규격|구성|requirements?|spec(?:ification)?s?)\s*[\])>】:]?$")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", extract.normalize(text)).strip(" -•*·\t").lower()


def _tag_lines(lines: list[str], requirements: list[dict], items: list[dict]) -> list[dict]:
    norms = [_norm(line) for line in lines]
    # 요구사항 → 근거가 된 줄 (근거가 줄의 일부이거나 줄이 근거의 일부)
    for req in requirements:
        if req.get("line") is not None:
            continue
        sources = [_norm(src) for src in (req.get("sources") or [req.get("source", "")]) if src]
        # 1) 근거가 통째로 들어 있는 줄들 → 2) 그런 줄이 없을 때만 근거의 일부인 줄들
        #    (PDF처럼 '항목명 줄 + 값 줄'이 이어진 근거). 대표 줄은 숫자가 있는 줄
        hits = [i for i, line in enumerate(norms) if line and any(src and src in line for src in sources)]
        if not hits:
            hits = [i for i, line in enumerate(norms) if len(line) >= 2 and any(line in src for src in sources)]
        if hits:
            req["line"] = next((i for i in hits if re.search(r"\d", norms[i])), hits[0])
            req["lines"] = hits
    used = {i for req in requirements for i in (req.get("lines") or ([req["line"]] if req.get("line") is not None else []))}
    out = []
    for index, raw in enumerate(lines):
        line = norms[index]
        if not line or not re.search(r"[0-9A-Za-z가-힣]", line):
            continue
        row = {"n": index, "text": raw.strip()}
        item = next((it for it in items if (it.get("code") and _norm(it["code"]) in line)
                     or (it.get("desc") and _norm(it["desc"]) in line)), None)
        if index in used:
            row["status"] = "req"
        elif item and item.get("category") != "unknown":
            row["status"] = "skip" if item["category"] in SKIP_CATEGORIES else "part"
            qty = f" × {item['qty']:g}" if item.get("qty") else ""
            row["label"] = f"{item.get('category_ko') or item['category']} · {item.get('desc', '')}{qty}"
        elif (extract._server_name(raw) and len(raw.split()) <= 8) or HEADING.search(line):
            row["status"] = "head"
        else:
            row["status"] = "warn"
            cats = [cat for cat, pattern in extract.SPEC_CATS if re.search(pattern, line, re.I)]
            row["hint"] = f"{', '.join(cats)} 관련 문장인데 기준값을 읽지 못했습니다" if cats else "자동으로 읽지 못한 줄입니다"
        out.append(row)
    return out


def _server(group: dict, text: str) -> dict:
    lines = text.splitlines()
    requirements = group.get("requirements") or []
    items = group.get("items") or []
    return {**{k: v for k, v in group.items() if k != "text"}, "text": text,
            "lines": _tag_lines(lines, requirements, items)}


def _group_text(group: dict, text: str) -> str:
    """나눌 서버의 원문: 요구사항 문서는 구간 텍스트, 견적은 그 서버 품목이 있는 줄."""
    if group.get("text"):
        return group["text"]
    items = group.get("items") or []
    keep = [line for line in text.splitlines()
            if any((it.get("code") and it["code"] in line) or (it.get("desc") and it["desc"] in line) for it in items)]
    return "\n".join(keep) or text


def analyze(text: str, suggest) -> dict:
    """→ {server: 붙여넣은 전체를 서버 1대로 본 결과, split: 서버가 여럿 보이면 서버별 결과 (아니면 [])}.
    suggest(group, text) 는 추천 모델을 붙이는 콜백."""
    try:
        doc = doc_tables.analyze_document("붙여넣기.tsv", text.encode("utf-8"), text)
    except Exception:  # 표 해석 실패해도 요구사항 규칙은 돌린다
        doc = {"doc_role": "requirement", "groups": []}
    groups = doc.get("groups") or []
    split = []
    common = ""
    if len(groups) > 1:
        if doc.get("doc_role") != "quote":
            common = _common_text(text, groups)
        for group in groups:
            section = _group_text(group, text)
            if common:
                # 첫 서버 제목 앞의 공통 요구사항은 모든 서버에 넣는다
                section = common + "\n" + section
                group = {**group, "requirements": extract.extract_requirements(section), "spec": extract.spec_summary(section)}
            suggest(group, section)
            split.append(_server(group, section))

    if doc.get("doc_role") == "quote" and groups:
        whole = dict(groups[0])
        if len(groups) > 1:
            whole["notes"] = [*(whole.get("notes") or []), f"본체가 {len(groups)}대로 보여 첫 번째 본체 구성을 적용했습니다 — 서버별로 나누세요"]
        # 한 서버로 볼 때도 모든 품목 줄이 표시되게 품목을 합친다
        whole["items"] = [it for group in groups for it in group.get("items") or []]
    else:
        whole = {"id": "server-1", "name": "서버 1", "doc_role": "requirement",
                 "requirements": extract.extract_requirements(text), "spec": extract.spec_summary(text)}
        if groups and groups[0].get("quantity") and len(groups) == 1:
            whole["quantity"] = groups[0]["quantity"]
    suggest(whole, text)
    return {"server": _server(whole, text), "split": split, "common_lines": len(common.splitlines()) if common else 0,
            "inventory": doc.get("inventory", [])}


def _common_text(text: str, groups: list[dict]) -> str:
    """첫 서버 구간이 시작되기 전의 줄 (제목 줄은 뺀다)."""
    first = next((g.get("text") for g in groups if g.get("text")), "")
    first_line = _norm(first.splitlines()[0]) if first.strip() else ""
    lines = text.splitlines()
    out = []
    for line in lines:
        norm = _norm(line)
        if first_line and norm == first_line:
            break
        if norm and not HEADING.search(norm):
            out.append(line)
    # 끝에 붙은 첫 서버 제목 줄 제거
    while out and extract._server_name(out[-1]):
        out.pop()
    return "\n".join(out).strip() if len(out) < len(lines) else ""
