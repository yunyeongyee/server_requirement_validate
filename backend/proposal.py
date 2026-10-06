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
    return None


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


def _fits(slot, comp, cpu_count):
    if slot["type"] == "ocp":
        return comp["form"] == "ocp"
    if comp["form"] == "ocp":
        return False
    if comp["lanes"] > slot["lanes"]:
        return False
    if comp["height"] == "FH" and slot["height"] == "LP":
        return False
    return slot["cpu"] <= cpu_count


def to_config(server: dict, proposed: dict, catalog: dict, base_cfg: dict, backplane_hint: dict | None = None) -> dict:
    cfg = {**base_cfg, "bays": {}, "slots": {}, "memory": [], "raid": dict(base_cfg.get("raid", {}))}
    notes: list[str] = []

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
            notes.append(f"'{d['desc']}' 에 맞는 디스크 옵션 없음"); continue
        def gb(o):
            m = re.search(r"(\d+(?:\.\d+)?)\s*(TB|GB)", o["name"])
            return float(m.group(1)) * (1000 if m and m.group(2) == "TB" else 1) if m else 0
        def media(o):
            return "SSD" if re.search(r"ssd|nvme", o["name"], re.I) else "HDD"
        want = d.get("size_gb") or 0
        # 용량 → 매체(SSD/HDD) → 인터페이스 순으로 가깝게. 인터페이스만 맞추다 용량이 크게 어긋나는 것을 막는다.
        def score(o):
            size = abs(math.log((gb(o) or 1) / want)) if want else 0
            return (size
                    + (1.0 if d.get("media") and media(o) != d["media"].upper() else 0)
                    + (0.3 if d.get("iface") and o["iface"] != d["iface"] else 0))
        opt = min(opts, key=score)
        diff = [x for x, bad in (
            (f"용량 {gb(opt):g}GB", want and abs(gb(opt) - want) / want > 0.05),
            (f"인터페이스 {opt['iface']}", d.get("iface") and opt["iface"] != d["iface"]),
        ) if bad]
        if diff:
            notes.append(f"'{d['desc']}' → 카탈로그에 같은 디스크가 없어 '{opt['name']}'로 대체 ({', '.join(diff)}) — 디스크 옵션 확인")
        role = "boot" if (len(drives) > 1 and i == 0 and d["qty"] == 2) else "data"
        for _ in range(d["qty"]):
            if bay >= bp["bays"]:
                notes.append(f"전면 베이 부족: '{d['desc']}' 일부 미배치"); break
            cfg["bays"][str(bay)] = {"drive": opt["id"], "role": role}; bay += 1

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
            for _ in range(it.get("qty") or 1):
                c = _pick_component(catalog, cat, it)
                if not c:
                    notes.append(f"'{it['desc']}' 에 해당하는 카탈로그 부품 없음"); continue
                if not c["_exact"]:
                    notes.append(f"'{it['desc']}' → 가장 가까운 '{c['name']}' 로 대체(사양 확인)")
                cards.append((it, c))
    cards.sort(key=lambda x: (x[1]["form"] != "ocp", x[1]["height"] != "FH"))
    cfg["risers"] = [r["id"] for r in server["risers"]]   # 카드 배치를 위해 일단 전체 라이저, 이후 사용 라이저만 남김
    used_risers = set()
    for it, c in cards:
        slot = next((s for s in server["slots"] if s["id"] not in cfg["slots"] and _fits(s, c, cfg["cpu_count"])), None)
        if not slot:
            notes.append(f"'{it['desc']}' 를 꽂을 수 있는 빈 슬롯 없음"); continue
        cfg["slots"][slot["id"]] = c["id"]
        if slot.get("riser"):
            used_risers.add(slot["riser"])
    cfg["risers"] = sorted(used_risers | {r["id"] for r in server["risers"] if r.get("default")})
    return {"config": cfg, "notes": notes}
