"""견적서에서 읽은 '제안 구성'을 선택한 서버 모델의 ServerConfig 로 옮긴다.

옮길 수 없는 항목(카탈로그에 없는 CPU, 맞는 슬롯 없음 등)은 버리지 않고 notes 로 돌려준다.
호환성 '판정'은 하지 않는다 — 판정은 validate.py 가 한다. 여기서는 배치만 제안한다.
"""
from __future__ import annotations
import math, re


def suggest_server(model_hint: str | None, servers: list[dict]) -> str | None:
    if not model_hint:
        return None
    k = re.sub(r"\s+", "", model_hint).upper()
    for s in servers:
        if re.sub(r"\s+", "", s["model"]).upper() == k:
            return s["id"]
    # R660xs · R760XA 처럼 뒤에 변형 표기가 붙은 모델은 같은 계열(R660·R760)로 본다 — 가장 긴 접두 일치
    near = [s for s in servers if k.startswith(re.sub(r"\s+", "", s["model"]).upper())]
    return max(near, key=lambda s: len(s["model"]))["id"] if near else None


def _nearest(options, value, prefer_ge=True):
    if not options or value is None:
        return None
    ge = [o for o in options if o >= value]
    return min(ge) if (prefer_ge and ge) else min(options, key=lambda o: abs(o - value))


def _pick_component(catalog: dict, category: str, item: dict) -> dict | None:
    cands = [c for c in catalog.values() if c["category"] == category]
    if not cands:
        return None
    sp, po, h = item.get("speed_gb"), item.get("ports"), item.get("height")
    def score(c):
        s = 0
        if sp is not None: s -= abs((c.get("speed_gb") or 0) - sp) * 10
        if po is not None: s -= abs((c.get("ports") or 0) - po) * 3
        if h and c.get("height") == h: s += 2
        return s
    best = max(cands, key=score)
    exact = (sp is None or best.get("speed_gb") == sp) and (po is None or best.get("ports") == po)
    return {**best, "_exact": exact}


GPU_FAMILY = [  # 품명 표현 → 카탈로그에서 찾을 이름 (같은 급 대체 순서)
    (r"\bh\d{3}|gh200|b200|a100", ["H100", "L40S"]),
    (r"\bl40s?\b|a40|a6000|rtx\s*6000", ["L40S", "H100"]),
    (r"\bl4\b|a2\b|a16|t4\b", ["L4"]),
]


def _pick_gpu(catalog: dict, desc: str) -> tuple[dict | None, bool]:
    gpus = [c for c in catalog.values() if c["category"] == "GPU"]
    if not gpus:
        return None, False
    low = desc.lower()
    exact = next((c for c in gpus if c.get("short")
                  and re.search(r"\b" + re.escape(c["short"].lower().replace("nvidia ", "")) + r"\b", low)), None)
    if exact:
        return exact, True
    for pattern, names in GPU_FAMILY:
        if re.search(pattern, low):
            for name in names:
                hit = next((c for c in gpus if name.lower() in c["name"].lower()), None)
                if hit:
                    return hit, False
    return max(gpus, key=lambda c: c.get("power_w", 0)), False


def _fits(slot, comp, cpu_count):
    if slot["type"] == "ocp":
        return comp["form"] == "ocp"
    if comp["form"] == "ocp":
        return False
    if comp["lanes"] > slot["lanes"]:
        return False
    if comp["height"] == "FH" and slot["height"] == "LP":
        return False
    if comp.get("double_width") and not slot.get("double_width_ok"):
        return False
    return slot["cpu"] <= cpu_count


def to_config(server: dict, proposed: dict, catalog: dict, base_cfg: dict, backplane_hint: dict | None = None, substitute: list[str] | None = None) -> dict:
    cfg = {**base_cfg, "bays": {}, "slots": {}, "memory": [], "raid": dict(base_cfg.get("raid", {}))}
    notes: list[str] = []
    allowed = set(substitute or [])            # 사용자가 '대체 배치'를 승인한 견적 품명
    unresolved: list[dict] = []                # 정확히 같은 부품이 없어 장착하지 않은 항목 (임의 대체 금지)
    labels: dict = {"slots": {}, "bays": {}, "psu": (proposed.get("psu") or {}).get("desc")}

    cpu = proposed.get("cpu") or {}
    if cpu.get("count"):
        cfg["cpu_count"] = min(cpu["count"], server["cpu_sockets"])
        if cpu["count"] > server["cpu_sockets"]:
            notes.append(f"CPU {cpu['count']}개 → 서버 소켓 {server['cpu_sockets']}개로 제한")
    if cpu.get("model"):
        hit = next((o for o in server["cpu_options"] if cpu["model"].lower().replace("intel ", "") in o.lower()
                    or o.lower() in cpu["model"].lower()), None)
        if hit:
            cfg["cpu_model"] = hit
        else:
            notes.append(f"CPU '{cpu['model']}' 는 이 모델의 CPU 목록에 없음 — CPU 모델은 직접 확인")

    for d in (proposed.get("memory") or {}).get("dimms", []):
        size = d["size_gb"]
        if size not in server["memory"]["dimm_sizes_gb"]:
            notes.append(f"{size}GB DIMM 은 카탈로그에 없어 가장 가까운 크기로 대체")
            size = _nearest(server["memory"]["dimm_sizes_gb"], size, False)
        cfg["memory"].append({"size_gb": size, "qty": d["qty"]})

    # 백플레인: 본체 품명의 베이 수/규격과 맞는 것
    bp = None
    if backplane_hint and backplane_hint.get("bays"):
        bp = next((b for b in server["backplanes"] if b["bays"] == backplane_hint["bays"]
                   and (not backplane_hint.get("ff") or b["ff"] == backplane_hint["ff"])), None)
    cfg["backplane"] = (bp or server["backplanes"][0])["id"]
    if backplane_hint and backplane_hint.get("bays") and not bp:
        notes.append(f"전면 {backplane_hint['bays']}베이 백플레인이 이 모델 데이터에 없음 — 백플레인 확인")
    bp = next(b for b in server["backplanes"] if b["id"] == cfg["backplane"])

    # 디스크: M.2 → BOSS, 나머지 → 전면 베이 순서대로
    bay = 0
    drives = proposed.get("drives") or []
    for i, d in enumerate(drives):
        if d.get("ff") == "M.2":
            cfg["boss"] = True
            notes.append(f"M.2 {d.get('size_gb', ''):g}GB × {d['qty']} → BOSS(M.2 부트)로 반영")
            continue
        opts = [o for o in server["drive_options"] if (not d.get("ff") or o["ff"] == d["ff"])]
        if not opts:
            notes.append(f"'{d['desc']}' 에 맞는 디스크 옵션 없음")
            unresolved.append({"category": "drive", "desc": d["desc"], "qty": d["qty"], "nearest": None, "reason": f"{d.get('ff') or ''} 규격의 디스크 옵션이 이 모델에 없음"})
            continue
        def gb(o):
            m = re.search(r"(\d+(?:\.\d+)?)\s*(TB|GB)", o["name"])
            return float(m.group(1)) * (1000 if m and m.group(2) == "TB" else 1) if m else 0
        def media(o):
            return "SSD" if re.search(r"ssd|nvme", o["name"], re.I) else "HDD"
        want = d.get("size_gb") or 0
        def mismatch(o):
            """견적 품명과 어떤 점이 다른가 (비면 정확히 같은 부품)"""
            out = []
            if want and abs(gb(o) - want) / want > 0.05: out.append(f"용량 {gb(o):g}GB")
            if d.get("iface") and o["iface"] != d["iface"]: out.append(f"인터페이스 {o['iface']}")
            if d.get("media") and media(o) != d["media"].upper(): out.append(f"종류 {media(o)}")
            return out
        def score(o):
            size = abs(math.log((gb(o) or 1) / want)) if want else 0
            return size + (1.0 if d.get("media") and media(o) != d["media"].upper() else 0) + (0.3 if d.get("iface") and o["iface"] != d["iface"] else 0)
        # 같은 부품(다른 점 없음)이 있으면 그것을, 없으면 가장 가까운 것을 후보로 (단, 승인 없이는 장착하지 않는다)
        exact = [o for o in opts if not mismatch(o)]
        opt = min(exact, key=score) if exact else min(opts, key=score)
        diff = mismatch(opt)
        if diff and d["desc"] not in allowed:
            # 견적의 SATA 를 SAS 부품으로 몰래 바꾸지 않는다 — 장착하지 않고 확인을 요청
            notes.append(f"'{d['desc']}' 와 같은 디스크가 카탈로그에 없어 장착하지 않음 (가장 가까운 '{opt['name']}' 은 {', '.join(diff)} 이(가) 다름) — 확인 필요")
            unresolved.append({"category": "drive", "desc": d["desc"], "qty": d["qty"], "nearest": opt["name"], "reason": f"다른 점: {', '.join(diff)}"})
            continue
        if diff:
            notes.append(f"'{d['desc']}' → '{opt['name']}' 로 대체 배치 (사용자 승인 · {', '.join(diff)} 다름)")
        # 용도는 견적 품명에 Boot/OS/부트 표기가 있을 때만 Boot, 그 외는 Data — 줄 순서나 수량으로 추측하지 않는다
        role = "boot" if re.search(r"boot|부트|\bos\b|운영\s*체제", d.get("desc", ""), re.I) else "data"
        for _ in range(d["qty"]):
            if bay >= bp["bays"]:
                notes.append(f"전면 베이 부족: '{d['desc']}' 일부 미배치"); break
            cfg["bays"][str(bay)] = {"drive": opt["id"], "role": role}; labels["bays"][str(bay)] = d["desc"]; bay += 1

    data_n = sum(1 for b in cfg["bays"].values() if b["role"] == "data")
    boot_n = sum(1 for b in cfg["bays"].values() if b["role"] == "boot")
    cfg["raid"]["boot"] = "RAID1" if boot_n == 2 or cfg.get("boss") else ""
    cfg["raid"]["data"] = ("RAID1" if data_n == 2 else "RAID5" if data_n >= 3 else "") if proposed.get("raid") else ""
    if data_n and proposed.get("raid"):
        notes.append(f"Data 디스크 {data_n}개 → {cfg['raid']['data'] or 'No RAID'} 로 가정 (문서에 RAID 수준이 없으면 확인)")
    if proposed.get("raid"):
        if any("vroc" in r.lower() for r in proposed["raid"]):
            notes.append("VROC(소프트웨어 RAID) 키 포함 — RAID 수준은 직접 확인")

    psu = proposed.get("psu") or {}
    if psu.get("watt"):
        w = _nearest(server["psu_options"], psu["watt"])
        cfg["psu_watt"] = w
        if w != psu["watt"]:
            notes.append(f"PSU {psu['watt']}W → 이 모델 옵션 {w}W 로 근사")
    if psu.get("count"):
        cfg["psu_count"] = min(psu["count"], server["psu_bays"])

    # 슬롯 배치: OCP 먼저, 그 다음 FH 카드(제약 큼) → LP 카드
    cards = []
    for kind, cat in (("ocp", "OCP NIC"), ("fc", "FC HBA"), ("nic", "NIC")):
        for it in proposed.get(kind) or []:
            c = _pick_component(catalog, cat, it)
            if not c:
                notes.append(f"'{it['desc']}' 에 해당하는 카탈로그 부품 없음")
                unresolved.append({"category": kind, "desc": it["desc"], "qty": it.get("qty") or 1, "nearest": None, "reason": f"{cat} 카탈로그 부품이 없음"})
                continue
            if not c["_exact"] and it["desc"] not in allowed:
                # 포트 수·속도가 다른 부품을 임의로 꽂지 않는다 (판정이 틀어짐)
                notes.append(f"'{it['desc']}' 와 같은 카탈로그 부품이 없어 장착하지 않음 (가장 가까운 '{c['name']}' 은 속도·포트 수가 다름) — 확인 필요")
                unresolved.append({"category": kind, "desc": it["desc"], "qty": it.get("qty") or 1, "nearest": c["name"], "reason": "속도 또는 포트 수가 다름"})
                continue
            if not c["_exact"]:
                notes.append(f"'{it['desc']}' → '{c['name']}' 로 대체 배치 (사용자 승인)")
            for _ in range(it.get("qty") or 1):
                cards.append((it, c))
    # GPU: 품명의 모델과 같은 것만 장착, 같은 급 대체는 승인 후
    for it in proposed.get("gpu") or []:
        c, exact = _pick_gpu(catalog, it.get("desc", ""))
        if not c:
            notes.append(f"'{it['desc']}' 에 해당하는 카탈로그 GPU 없음")
            unresolved.append({"category": "gpu", "desc": it["desc"], "qty": it.get("qty") or 1, "nearest": None, "reason": "GPU 카탈로그 부품이 없음"})
            continue
        if not exact and it["desc"] not in allowed:
            notes.append(f"'{it['desc']}' 와 같은 GPU 가 카탈로그에 없어 장착하지 않음 (가장 가까운 '{c['name']}') — 확인 필요")
            unresolved.append({"category": "gpu", "desc": it["desc"], "qty": it.get("qty") or 1, "nearest": c["name"], "reason": "같은 GPU 가 아님"})
            continue
        if not exact:
            notes.append(f"'{it['desc']}' → '{c['name']}' 로 대체 배치 (사용자 승인) — 전원·쿨링·슬롯 확인")
        for _ in range(it.get("qty") or 1):
            cards.append((it, c))
    # GPU(더블 폭)처럼 제약이 큰 카드부터 자리를 잡는다
    cards.sort(key=lambda x: (x[1]["form"] != "ocp", not x[1].get("double_width"), x[1]["height"] != "FH"))
    cfg["risers"] = [r["id"] for r in server["risers"]]   # 카드 배치를 위해 일단 전체 라이저, 이후 사용 라이저만 남김
    used_risers = set()
    for it, c in cards:
        slot = next((s for s in server["slots"] if s["id"] not in cfg["slots"] and _fits(s, c, cfg["cpu_count"])), None)
        if not slot:
            notes.append(f"'{it['desc']}' 를 꽂을 수 있는 빈 슬롯 없음"); continue
        cfg["slots"][slot["id"]] = c["id"]
        labels["slots"][slot["id"]] = {"comp": c["id"], "desc": it["desc"]}
        if slot.get("riser"):
            used_risers.add(slot["riser"])
    cfg["risers"] = sorted(used_risers | {r["id"] for r in server["risers"] if r.get("default")})
    return {"config": cfg, "labels": labels, "notes": list(dict.fromkeys(notes)), "unresolved": unresolved}  # 같은 품목 여러 개의 같은 안내는 한 번만
