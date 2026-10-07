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
import logging, re

from . import ai_normalize as A, doc_tables, extract, parts

logger = logging.getLogger(__name__)

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


def _tag_lines(lines: list[str], requirements: list[dict], items: list[dict], ignored: dict | None = None) -> list[dict]:
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
        elif ignored and index in ignored:
            row["status"] = "skip"
            row["label"] = f"AI가 제외: {ignored[index]}" if ignored[index] else "AI가 제외"
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


def _server(group: dict, text: str, ignored: dict | None = None) -> dict:
    lines = text.splitlines()
    requirements = group.get("requirements") or []
    items = group.get("items") or []
    return {**{k: v for k, v in group.items() if k != "text"}, "text": text,
            "lines": _tag_lines(lines, requirements, items, ignored)}


def _group_text(group: dict, text: str) -> str:
    """나눌 서버의 원문: 요구사항 문서는 구간 텍스트, 견적은 그 서버 품목이 있는 줄."""
    if group.get("text"):
        return group["text"]
    items = group.get("items") or []
    keep = [line for line in text.splitlines()
            if any((it.get("code") and it["code"] in line) or (it.get("desc") and it["desc"] in line) for it in items)]
    return "\n".join(keep) or text


def analyze(text: str, suggest, kind: str = "requirement", use_ai: bool = False, rule_lines=()) -> dict:
    """kind = 어느 칸에 붙여넣었는지. 판정하지 않고 칸이 정한다 (요구사항을 견적으로, 견적을 요구사항으로 잘못 읽지 않게).
      requirement: 요구사항 / quote: 견적 표(품목 → 제안 구성). 서버가 여럿이면 나누기 제안
    use_ai: AI 로 정규화(기본값) — 규칙 파서 결과와 다르면 ai.conflicts 로 돌려준다. 실패하면 규칙 결과 + 안내.
    rule_lines: 사용자가 '규칙 값'을 고른 줄(0부터). → {server, split, common_lines, ai}"""
    rule_lines = {int(n) for n in rule_lines}
    lines = text.splitlines()
    rule = _quote_rule(text) if kind == "quote" else _requirement_rule(text)
    ai: dict = {"used": False, "notice": None, "conflicts": [], "rule_lines": sorted(rule_lines)}
    built = None
    if use_ai:
        if not A.enabled():
            ai["notice"] = "AI 키가 설정되어 있지 않아 규칙으로 분석했습니다 (.env 의 OPENAI_API_KEY)"
        else:
            try:
                built = _with_ai(kind, text, lines, rule, rule_lines)
                ai.update(used=True, model=A.settings()["model"], conflicts=built["conflicts"])
            except A.AIError as error:
                ai["notice"] = f"AI 분석에 실패해 규칙으로 분석했습니다 — {error.user_message}"
            except Exception:  # 예상 못한 응답도 분석 전체를 멈추지 않는다
                logger.exception("AI normalization failed")
                ai["notice"] = "AI 분석 중 오류가 나서 규칙으로 분석했습니다"
    groups, ignored = (built["groups"], built["ignored"]) if built else (rule["groups"], {})
    if kind == "quote":
        out = _quote_response(groups, text, suggest, ignored, built["common_note"] if built else None)
    else:
        out = _requirement_response(groups, built["common"] if built else None, text, suggest, ignored, rule)
    if out.get("error") and built is None and not groups:
        return out
    out["ai"] = ai
    if out.get("server") is not None:
        out["server"]["ai"] = ai
    for part in out.get("split") or []:
        part["ai"] = {**ai, "conflicts": part.pop("_conflicts", [])}
    return out


def _carve(lines: list[str], wanted: set[int], reqs=None, items=None, conflicts=None):
    """전체 원문에서 이 서버에 속한 줄만 떼어 내고, 항목의 줄 번호를 새 번호로 바꾼다."""
    idx = sorted(i for i in wanted if 0 <= i < len(lines))
    pos = {old: new for new, old in enumerate(idx)}
    text = "\n".join(lines[i] for i in idx)
    def remap(r):
        mapped = [pos[i] for i in (r.get("lines") or []) if i in pos]
        line = pos.get(r.get("line"))
        return {**r, "line": line if line is not None else (mapped[0] if mapped else None), "lines": mapped}
    new_conflicts = [{**c, "line": pos[c["line"]]} for c in conflicts or [] if c["line"] in pos]
    return text, [remap(r) for r in reqs or []], [remap(i) for i in items or []], new_conflicts, pos


# ── 규칙 파서 (AI 가 꺼져 있거나 실패했을 때, 그리고 AI 결과와 비교할 때) ──
def _requirement_rule(text: str) -> dict:
    groups = extract.extract_server_groups(text)
    split, common = [], ""
    if len(groups) > 1:
        common = _common_text(text, groups)
        for group in groups:
            section = (common + "\n" + group["text"]) if common else group["text"]
            m = doc_tables.HEAD_QTY.search(group["name"])
            group = {**group, "name": doc_tables.clean_name(group["name"]), "quantity": int(m.group(1)) if m else None,
                     "doc_role": "requirement", "requirements": extract.extract_requirements(section),
                     "spec": extract.spec_summary(section), "_section": section}
            split.append(group)
    joined = "\n".join(t for _, t in _logical(text.splitlines()))
    whole = {"id": "server-1", "name": "서버 1", "doc_role": "requirement",
             "requirements": extract.extract_requirements(joined), "spec": extract.spec_summary(joined)}
    _tag_lines(text.splitlines(), whole["requirements"], [])   # 규칙 항목에 원문 줄 번호를 붙인다 (AI 결과와 줄 단위 비교용)
    return {"groups": split, "whole": whole, "common_lines": len(common.splitlines()) if common else 0}


def _quote_rule(text: str) -> dict:
    try:
        res = doc_tables.analyze("붙여넣기.tsv", text.encode("utf-8"))
    except Exception:
        res = {"groups": []}
    groups = [{**g, "doc_role": "quote", "requirements": [], "spec": []} for g in res.get("groups") or [] if g.get("items")]
    if not groups:
        groups = _quote_by_lines(text)
    return {"groups": groups}


def _with_ai(kind: str, text: str, lines: list[str], rule: dict, rule_lines: set[int]) -> dict:
    if kind == "quote":
        result = A.normalize("quotation", lines)
        out = A.quote_from_ai(result, lines, rule["groups"], rule_lines)
        if not out["groups"]:
            raise A.AIError("empty", "AI가 견적 품목을 찾지 못했습니다")
        out["common_note"] = None
        out["common"] = []
        return out
    result = A.normalize("requirement", lines)
    out = A.requirements_from_ai(result, lines, rule["whole"]["requirements"], rule_lines)
    if not out["groups"] and not out["common"]:
        raise A.AIError("empty", "AI가 요구사항을 찾지 못했습니다")
    return out


# ── 응답 조립 ──
def _requirement_response(groups, common, text, suggest, ignored, rule) -> dict:
    lines = text.splitlines()
    if common is None:  # 규칙 결과
        split = []
        for group in groups:
            section = group.pop("_section", group.get("text", ""))
            suggest(group, section)
            built = _server(group, section)
            built["_conflicts"] = []
            split.append(built)
        whole = rule["whole"]
        suggest(whole, text)
        return {"server": _server(whole, text), "split": split, "common_lines": rule["common_lines"]}
    # AI 결과: 서버 그룹이 하나면 한 서버, 여럿이면 나누기 제안
    everything = [r for g in groups for r in g["requirements"]] + common
    seen, union = set(), []
    for r in everything:
        k = (r["key"], r.get("op"), str(r.get("value")), tuple(r.get("lines") or []))
        if k not in seen:
            seen.add(k)
            union.append(r)
    split = []
    if len(groups) > 1:
        for g in groups:
            reqs = g["requirements"] + common
            wanted = {i for r in reqs for i in (r.get("lines") or [])}
            section, rs, _, _, _ = _carve(lines, wanted, reqs=reqs)
            group = {"id": "server-x", "name": doc_tables.clean_name(g["name"]) or "서버", "quantity": g.get("quantity"),
                     "doc_role": "requirement", "requirements": rs, "spec": []}
            suggest(group, section)
            built = _server(group, section)
            built["_conflicts"] = []
            split.append(built)
    whole = {"id": "server-1", "name": "서버 1", "doc_role": "requirement", "requirements": union, "spec": []}
    if len(groups) == 1 and groups[0].get("quantity"):
        whole["quantity"] = groups[0]["quantity"]
    suggest(whole, text)
    return {"server": _server(whole, text, ignored), "split": split, "common_lines": len(common)}


def _quote_response(groups, text, suggest, ignored, common_note) -> dict:
    if not groups:
        return {"server": None, "split": [], "common_lines": 0,
                "error": "견적 표로 읽지 못했습니다 — 품명과 수량이 있는 표를 엑셀에서 그대로 긁어 붙여넣으세요"}
    lines = text.splitlines()
    split = []
    if len(groups) > 1:
        for group in groups:
            wanted = {i["line"] for i in group.get("items") or [] if i.get("line") is not None}
            if wanted:
                section, _, items, _, _ = _carve(lines, wanted, items=group.get("items"))
                group = {**group, "items": items}
            else:
                section = _group_text(group, text)
            suggest(group, section)
            built = _server(group, section)
            built["_conflicts"] = []
            split.append(built)
    whole = dict(groups[0])
    if len(groups) > 1:
        whole["notes"] = [*(whole.get("notes") or []), f"본체가 {len(groups)}대로 보여 첫 번째 본체 구성을 적용했습니다 — 서버별로 나누세요"]
    whole["items"] = [it for group in groups for it in group.get("items") or []]
    suggest(whole, text)
    return {"server": _server(whole, text, ignored), "split": split, "common_lines": 0}


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
