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


BULLET = re.compile(r"^\s*(?:[•\-\*·□■○●▶▷◦‣]|\d+[.)]|[가-하][.)])\s*")
CONT_WORD = re.compile(r"^(?:이상|이하|미만|초과|以上|or more|at least)\W*$", re.I)
CONNECTIVE = re.compile(r"^(?:하며|하고|하여|및|또는|그리고|으로|로서|등|이며|하여야|해야)")
REQ_ID = re.compile(r"^[A-Z]{2,6}[-_ ]?\d{1,4}(?:[-_.]\d+)?$")
SOFTWARE = re.compile(r"^\W*(?:os|운영\s*체제|o/s|소프트웨어|software|s/w|sw|라이선스|license|dbms|db)\s*[:：]|red\s*hat|rhel|windows\s*server|vmware|vsphere|ubuntu|suse|oracle\s*linux|rocky|centos", re.I)


def _logical(lines: list[str]) -> list[tuple[list[int], str]]:
    """줄바꿈으로 끊긴 문장을 잇는다: 다음 줄이 '이상'뿐이거나, 들여쓴 이어지는 줄이거나, '하며/및'으로 이어지면 앞 줄에 붙인다."""
    out: list[tuple[list[int], str]] = []
    for index, raw in enumerate(lines):
        text = raw.strip()
        if not text:
            continue
        if out:
            prev_idx, prev = out[-1]
            prev_open = not re.search(r"[.。!?]$|다\.?$", prev)
            indented = re.match(r"^(?:\s{2,}|\t)", raw) and not BULLET.match(raw)
            if CONT_WORD.match(text) or (indented and prev_open) or (prev_open and CONNECTIVE.match(text)):
                out[-1] = (prev_idx + [index], f"{prev} {text}")
                continue
        out.append(([index], text))
    return out


def _tag_lines(lines: list[str], requirements: list[dict], items: list[dict]) -> list[dict]:
    groups = _logical(lines)
    owner = {i: idx for idx, _ in groups for i in idx}   # 줄 → 그 줄이 속한 문장의 줄들
    norms = [_norm(line) for line in lines]
    gnorm = {idx[0]: _norm(text) for idx, text in groups}
    # 요구사항 → 근거가 된 줄 (근거가 줄의 일부이거나 줄이 근거의 일부)
    for req in requirements:
        if req.get("line") is not None:
            continue
        sources = [_norm(src) for src in (req.get("sources") or [req.get("source", "")]) if src]
        # 1) 근거가 통째로 들어 있는 줄들 → 2) 그런 줄이 없을 때만 근거의 일부인 줄들
        #    (PDF처럼 '항목명 줄 + 값 줄'이 이어진 근거). 대표 줄은 숫자가 있는 줄
        hits = [i for i, line in enumerate(norms) if line and any(src and src in line for src in sources)]
        if not hits:  # 이어 붙인 문장에서 찾기
            hits = [i for first, text in gnorm.items() if text and any(src and src in text for src in sources) for i in owner[first]]
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
        if index in used or any(i in used for i in owner.get(index, [])):
            row["status"] = "req"
        elif item and item.get("category") != "unknown":
            row["status"] = "skip" if item["category"] in SKIP_CATEGORIES else "part"
            qty = f" × {item['qty']:g}" if item.get("qty") else ""
            row["label"] = f"{item.get('category_ko') or item['category']} · {item.get('desc', '')}{qty}"
        elif (extract._server_name(raw) and len(raw.split()) <= 8) or HEADING.search(line) or REQ_ID.match(raw.strip()):
            row["status"] = "head"
        elif SOFTWARE.search(raw):
            row["status"] = "skip"
            row["label"] = "OS·소프트웨어 — H/W 검증 대상 아님"
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


def analyze(text: str, suggest, kind: str = "requirement") -> dict:
    """kind = 어느 칸에 붙여넣었는지. 판정하지 않고 칸이 정한다 (요구사항을 견적으로, 견적을 요구사항으로 잘못 읽지 않게).
      requirement: 요구사항 규칙으로 읽기. 서버 제목이 여럿이면 나누기 제안
      quote      : 견적 표로 읽기(품목 → 제안 구성). 본체가 여럿이면 나누기 제안
    → {server, split, common_lines}. suggest(group, text) 는 추천 모델을 붙이는 콜백."""
    return _quote(text, suggest) if kind == "quote" else _requirement(text, suggest)


def _requirement(text: str, suggest) -> dict:
    groups = extract.extract_server_groups(text)
    split, common = [], ""
    if len(groups) > 1:
        common = _common_text(text, groups)
        for group in groups:
            section = (common + "\n" + group["text"]) if common else group["text"]
            m = doc_tables.HEAD_QTY.search(group["name"])
            group = {**group, "name": doc_tables.clean_name(group["name"]), "quantity": int(m.group(1)) if m else None,
                     "doc_role": "requirement", "requirements": extract.extract_requirements(section),
                     "spec": extract.spec_summary(section)}
            suggest(group, section)
            split.append(_server(group, section))
    joined = "\n".join(t for _, t in _logical(text.splitlines()))
    whole = {"id": "server-1", "name": "서버 1", "doc_role": "requirement",
             "requirements": extract.extract_requirements(joined), "spec": extract.spec_summary(joined)}
    suggest(whole, text)
    return {"server": _server(whole, text), "split": split, "common_lines": len(common.splitlines()) if common else 0}


def _quote(text: str, suggest) -> dict:
    try:
        res = doc_tables.analyze("붙여넣기.tsv", text.encode("utf-8"))
    except Exception:
        res = {"groups": []}
    groups = [{**g, "doc_role": "quote", "requirements": [], "spec": []} for g in res.get("groups") or [] if g.get("items")]
    if not groups:
        groups = _quote_by_lines(text)
    if not groups:
        return {"server": None, "split": [], "common_lines": 0,
                "error": "견적 표로 읽지 못했습니다 — 품명과 수량이 있는 표를 엑셀에서 그대로 긁어 붙여넣으세요"}
    split = []
    if len(groups) > 1:
        for group in groups:
            section = _group_text(group, text)
            suggest(group, section)
            split.append(_server(group, section))
    whole = dict(groups[0])
    if len(groups) > 1:
        whole["notes"] = [*(whole.get("notes") or []), f"본체가 {len(groups)}대로 보여 첫 번째 본체 구성을 적용했습니다 — 서버별로 나누세요"]
    whole["items"] = [it for group in groups for it in group.get("items") or []]
    suggest(whole, text)
    return {"server": _server(whole, text), "split": split, "common_lines": 0}


def _quote_by_lines(text: str) -> list[dict]:
    """표 머리글을 못 찾은 짧은 목록: 줄마다 품명·품번·수량을 읽어 견적 1대로 (본체가 여럿이면 나눔)."""
    blocks, items = [], []
    for n, raw in enumerate(text.splitlines(), 1):
        cells = re.split(r"\t|\s{2,}", raw.strip())
        desc, code, qty = doc_tables._guess_row(cells)
        if not desc and not code:
            continue
        it = doc_tables.Item(code, desc or code, qty, "", f"붙여넣기 {n}행", parts.interpret(code, desc or code))
        if it.interp["category"] == "base" and any(i.interp["category"] == "base" for i in items):
            blocks.append(items); items = []
        items.append(it)
    if items:
        blocks.append(items)
    hardware = [b for b in blocks if any(i.interp["category"] in doc_tables.HARDWARE | {"base"} for i in b)]
    return [{**doc_tables._make_group(k, None, "", None, doc_tables.Block(None, "", b, "붙여넣기", False), 1.0,
                                      ["붙여넣은 줄 단위로 읽음"], 0.6, None), "doc_role": "quote", "requirements": [], "spec": []}
            for k, b in enumerate(hardware, 1)]


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
