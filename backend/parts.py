"""부품 해석: 부품코드 사전 → 품명 규칙 → 확인 필요.

제조사·양식과 무관하게 동작하도록 '품명 문자열에 흔히 쓰이는 표현'만 규칙으로 쓴다.
특정 견적서의 코드 체계에 의존하지 않으며, 사용자가 확정한 해석은 data/parts.json 에 누적된다.
외부 전송 없음.
"""
from __future__ import annotations
import json, re, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DICT = ROOT / "data" / "parts.json"
_lock = threading.RLock()

# 서버 본체(베이스 유닛)로 볼 만한 표현. 모델명 사전(servers.json)과 함께 사용.
BASE_UNIT = re.compile(
    r"\b(?:base\s*unit|barebone|chassis|server\s*system|system\s*unit)\b|본체|섀시|베어본"
    r"|\b(?:PowerEdge\s*)?R\d{3}[a-z]{0,2}\b(?!\s*(?:raid|w\b))"
    r"|\bPRIMERGY\b|\b(?:RX|TX|CX)\d{3,4}\s*M\d+\b"
    r"|\bProLiant\b|\bDL\d{3}\s*Gen\d+\b|\bThinkSystem\s*SR\d{3}\b|\bSR\d{3}\s*V\d\b|\bUCS\s*C\d{3}\b"
    r"|\b(?:SYS|AS)-\d{4}[A-Z0-9-]*\b",
    re.I)
MODEL = re.compile(
    r"(?:PowerEdge\s*)?\b(R\d{3}[a-z]{0,2})\b|\b((?:RX|TX|CX)\d{3,4}\s*M\d+)\b|\b(DL\d{3}\s*Gen\d+)\b|\b(SR\d{3}\s*V?\d?)\b",
    re.I)
IGNORE = re.compile(
    r"cable|케이블|power\s*cord|파워\s*코드|rack\s*(?:mount)?\s*kit|rail|레일|region\s*kit|bezel|베젤|cooler|heat\s*sink|방열|fan\b"
    r"|adapter|어댑터|installation|설치|label|manual|documentation|warranty|support|유지\s*보수|carepack|care\s*pack|\bkey\b",
    re.I)
LICENSE = re.compile(r"\b(?:rhel|red\s*hat|windows\s*server|vmware|vsphere|suse|ubuntu|license|subscription|라이선스|os)\b|iRMC|iDRAC|iLO|XClarity", re.I)


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def load_dict() -> dict:
    with _lock:
        return json.loads(DICT.read_text(encoding="utf-8")) if DICT.exists() else {}


def learn(code: str, info: dict):
    """사용자가 확정한 부품 해석을 사전에 저장(다음 문서부터 자동)."""
    with _lock:
        d = load_dict()
        d[normalize_code(code)] = {**info, "source": "user"}
        DICT.parent.mkdir(parents=True, exist_ok=True)
        DICT.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def normalize_code(code: str) -> str:
    return re.sub(r"[\s\-_.]", "", str(code or "")).upper()


def model_of(desc: str) -> str | None:
    m = MODEL.search(desc or "")
    if not m:
        return None
    return re.sub(r"\s+", " ", next(g for g in m.groups() if g)).upper()


def interpret(code: str | None, desc: str | None) -> dict:
    """→ {category, attrs, confidence, how}. category: base|cpu|memory|drive|raid|fc|nic|ocp|psu|riser|gpu|transceiver|license|accessory|unknown"""
    d = load_dict()
    if code and normalize_code(code) in d:
        e = d[normalize_code(code)]
        return {"category": e.get("category", "unknown"), "attrs": e.get("attrs", {}), "confidence": 1.0, "how": "dict"}
    r = parse_desc(desc or "")
    r["how"] = "rule" if r["category"] != "unknown" else "none"
    return r


def parse_desc(desc: str) -> dict:
    t = re.sub(r"\s+", " ", desc).strip()
    L = t.lower()
    out = lambda cat, conf=0.85, **a: {"category": cat, "attrs": {k: v for k, v in a.items() if v is not None}, "confidence": conf}

    height = "LP" if re.search(r"\b(lp|low\s*profile|hhhl)\b", L) else ("FH" if re.search(r"\b(fh|full\s*height|fhhl|fhfl)\b", L) else None)
    ports = None
    m = re.search(r"(?<![a-z0-9])(\d+)\s*[x×]\s*(?:\d+\s*(?:g|gb|gbit|gbe)|sfp|port)|(?<![a-z0-9])(\d+)\s*-?\s*(?:port|포트|p)\b|(?<![a-z0-9])(\d)x\b", L)
    if m:
        ports = int(next(g for g in m.groups() if g))
    speed = None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:g|gb|gbit|gbe|gbps|gb/s)\b(?![\s/]*(?:ram|dimm|ddr|ssd|hdd|nvme|sas|sata|m\.2))", L)
    if m:
        speed = _num(m.group(1))

    if BASE_UNIT.search(t) and not re.search(r"riser|raid|\bnic\b|\bhba\b|\bpsu\b|power\s*supply|\d{3,4}\s*w\b", L):
        bays = re.search(r"(\d+)\s*x\s*(2\.5|3\.5)|(\d+)\s*(?:bay|베이|d\b)", L)
        return out("base", 0.8, model=model_of(t),
                   bays=int(bays.group(1) or bays.group(3)) if bays else None,
                   ff=bays.group(2) if bays and bays.group(2) else None)
    if re.search(r"\b(xeon|epyc|ampere)\b|\bcpu\b|프로세서|processor", L) and not IGNORE.search(L):
        cores = re.search(r"(\d+)\s*(?:c\b|core|코어)", L)
        ghz = re.search(r"(\d+(?:\.\d+)?)\s*ghz", L)
        model = re.search(r"(xeon[^,(|]*?|epyc[^,(|]*?)(?=\s+\d+\s*(?:c\b|core)|\s+\d+(?:\.\d+)?\s*ghz|[,(|]|$)", t, re.I)
        return out("cpu", 0.9, model=model.group(1).strip() if model else t, cores=int(cores.group(1)) if cores else None,
                   ghz=_num(ghz.group(1)) if ghz else None)
    if re.search(r"ddr[45]|rdimm|lrdimm|\bdimm\b|메모리|memory", L):
        m = re.search(r"(\d+)\s*(gb|tb)", L)
        size = (int(m.group(1)) * (1024 if m.group(2) == "tb" else 1)) if m else None
        return out("memory", 0.9 if size else 0.6, size_gb=size, type=(re.search(r"ddr[45]", L) or [None])[0])
    if re.search(r"\b(ssd|hdd|nvme|m\.2|nl-?sas|sas|sata)\b", L) and re.search(r"\d+(?:\.\d+)?\s*(gb|tb)", L) \
            and not re.search(r"raid|hba|controller|cable|케이블|backplane", L):
        m = re.search(r"(\d+(?:\.\d+)?)\s*(gb|tb)", L)
        size = _num(m.group(1)) * (1000 if m.group(2) == "tb" else 1)
        iface = "NVMe" if re.search(r"nvme|pcie\d?", L) else "SAS" if re.search(r"\bsas\b|nl-?sas", L) else "SATA" if "sata" in L else None
        ff = "M.2" if "m.2" in L else "3.5" if re.search(r"3\.5", L) else "2.5" if re.search(r"2\.5", L) else None
        return out("drive", 0.85, size_gb=size, iface=iface, ff=ff, media="HDD" if re.search(r"hdd|rpm|\d+k\b|nl-?sas", L) else "SSD")
    if re.search(r"\b(raid|perc|praid|megaraid|vroc|smart\s*array)\b|\bhba\b(?!.*\bfc\b)", L) and not re.search(r"\bfc\b|fibre|qle|lpe|\d+\s*gb\s*(fc|fibre)", L) and not re.search(r"no\s+hba", L):
        if "vroc" in L:
            return out("raid", 0.7, kind="software", note="VROC 키(소프트웨어 RAID)")
        return out("raid", 0.85, height=height, kind="controller")
    if re.search(r"no\s+(?:hba|raid)", L):
        return out("accessory", 0.9, note="옵션 없음 표시")
    if re.search(r"\b(fc|fibre|fiber\s*channel)\b|\bqle\d+|\blpe\d+", L):
        return out("fc", 0.9, speed_gb=speed, ports=ports, height=height)
    if re.search(r"transceiver|sfp\+?\s*module|sfp28\s*(?:module|transceiver)|\bgbic\b|\bsr\b.*lc|lc\b.*nm", L):
        return out("transceiver", 0.8, speed_gb=speed)
    if re.search(r"\bocp\s*v?3|\bocp\b", L) and re.search(r"lan|nic|ethernet|gb|port|sfp|cu\b|rj45|base-?t|plan", L):
        return out("ocp", 0.9, speed_gb=speed, ports=ports, media="SFP" if "sfp" in L else "Cu" if re.search(r"\bcu\b|rj45|base-?t|i350", L) else None)
    if re.search(r"\b(nic|lan|ethernet|이더넷|plan)\b|\d+\s*gbe\b|\bsfp(28|\+)?\b|base-?t|\bi350|\bx710|\be810|\bconnectx", L):
        return out("nic", 0.85, speed_gb=speed, ports=ports, height=height,
                   media="SFP" if "sfp" in L else "Cu" if re.search(r"\bcu\b|rj45|base-?t|i350", L) else None)
    if re.search(r"\b(psu|power\s*supply|전원\s*공급)\b|\d{3,4}\s*w\b.*(platinum|titanium|hp|hot|psu)", L):
        w = re.search(r"(\d{3,4})\s*w\b", L)
        return out("psu", 0.9, watt=int(w.group(1)) if w else None)
    if re.search(r"\briser\b|라이저", L):
        lanes = re.search(r"x\s*(16|8|4)\b", L)
        slots = re.search(r"x\s*(\d)\s*riser|\bx(\d)\b(?!\d)", L)
        return out("riser", 0.8, lanes=int(lanes.group(1)) if lanes else None, height=height)
    if re.search(r"\b(gpu|nvidia|tesla|a100|h100|l40s?|l4\b|radeon|instinct)\b", L):
        return out("gpu", 0.85)
    if re.search(r"m\.2\s*(carrier|module|boot)|boss", L):
        return out("boot_module", 0.8)
    if LICENSE.search(t):
        return out("license", 0.8)
    if IGNORE.search(L):
        return out("accessory", 0.8)
    return {"category": "unknown", "attrs": {}, "confidence": 0.0}


CATEGORY_KO = {"base": "본체", "cpu": "CPU", "memory": "Memory", "drive": "Disk", "raid": "RAID", "fc": "FC HBA",
               "nic": "NIC", "ocp": "OCP NIC", "psu": "PSU", "riser": "Riser", "gpu": "GPU", "transceiver": "트랜시버",
               "boot_module": "부트 모듈", "license": "라이선스/관리", "accessory": "부속품", "unknown": "미확인"}
