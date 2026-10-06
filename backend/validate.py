# 요구사항 + 서버 구성 검증
"""요구사항 충족 검증 + 슬롯/부품 호환성 검증.

결과 상태: PASS(충족) / FAIL(미충족) / INCOMPATIBLE(호환 불가) / REVIEW(확인 필요)
"""
from __future__ import annotations

PASS, FAIL, INCOMP, REVIEW = "충족", "미충족", "호환 불가", "확인 필요"
SEVERITY = {INCOMP: 3, FAIL: 2, REVIEW: 1, PASS: 0}

# 데모 규칙: 카드 lane > 슬롯 lane 이면 호환 불가 (물리적으로 x16 카드는 x8 커넥터에 장착 불가로 간주)
LANE_RULE_STRICT = True
PSU_HEADROOM = 0.8          # PSU 1대 용량의 80% 이내면 이중화 유지 가능으로 판단
BASE_POWER = {"cpu": 270, "dimm": 8, "drive": 10, "base": 150}


def _cmp(actual, op, target) -> bool:
    try:
        if op == ">=": return float(actual) >= float(target)
        if op == "<=": return float(actual) <= float(target)
        if op == ">":  return float(actual) > float(target)
        return str(actual).lower() == str(target).lower() or (
            isinstance(actual, (int, float)) and float(actual) == float(target))
    except (TypeError, ValueError):
        return False


def check_slots(server: dict, cfg: dict, catalog: dict) -> tuple[list[dict], dict]:
    """슬롯별 호환성 결과와 '유효 장착 부품' 목록을 돌려준다."""
    cpu_count = int(cfg.get("cpu_count", 2))
    risers = set(cfg.get("risers", []))
    placed = cfg.get("slots", {})  # {slot_id: component_id}
    results, effective = [], []

    for slot in server["slots"]:
        cid = placed.get(slot["id"])
        slot_ok_for_use = (slot["cpu"] <= cpu_count) and (slot["riser"] is None or slot["riser"] in risers)
        if not cid:
            results.append({"slot": slot["id"], "label": slot["label"], "component": None,
                            "status": None, "issues": [], "usable": slot_ok_for_use})
            continue
        comp = catalog.get(cid)
        issues = []
        if comp is None:
            issues.append((REVIEW, f"카탈로그에 없는 부품({cid})"))
        else:
            # A. OCP 호환성
            if slot["type"] == "ocp" and comp["form"] != "ocp":
                issues.append((INCOMP, "PCIe 카드는 OCP 슬롯에 장착 불가"))
            if slot["type"] != "ocp" and comp["form"] == "ocp":
                issues.append((INCOMP, "OCP 3.0 카드는 일반 PCIe 슬롯에 장착 불가"))
            if slot["type"] == "ocp" and comp["form"] == "ocp" and not server["ocp"]["supported"]:
                issues.append((INCOMP, "서버가 OCP를 지원하지 않음"))

            if comp["form"] == "pcie" and slot["type"] == "pcie":
                # B. PCIe Lane
                if comp["lanes"] > slot["lanes"]:
                    issues.append((INCOMP if LANE_RULE_STRICT else REVIEW,
                                   f"카드 x{comp['lanes']} > 슬롯 x{slot['lanes']} (데모 규칙: 장착 불가)"))
                # C. Form factor
                if comp["height"] == "FH" and slot["height"] == "LP":
                    issues.append((INCOMP, "Full Height 카드 → Low Profile 슬롯 장착 불가"))
                # F. GPU
                if comp["category"] == "GPU":
                    if not server["gpu"]["supported"]:
                        issues.append((INCOMP, "서버 GPU 미지원"))
                    if comp.get("double_width") and not slot.get("double_width_ok"):
                        issues.append((INCOMP, "Double-width GPU를 이 슬롯에 장착 불가(인접 슬롯 점유/공간)"))
                    issues.append((REVIEW, f"GPU {comp['power_w']}W: 보조전원 케이블·GPU Riser·쿨링(Fan/방열판) 확인 필요"))
                    if server["gpu"].get("requires_gpu_riser") and comp.get("double_width"):
                        issues.append((REVIEW, "GPU 전용 Riser 구성 여부 확인 필요"))

            # D. CPU dependency
            if slot["cpu"] > cpu_count:
                issues.append((INCOMP, f"CPU{slot['cpu']} 연결 슬롯 — CPU {slot['cpu']}개 이상 필요 (현재 {cpu_count}개)"))
            # E. Riser
            if slot["riser"] and slot["riser"] not in risers:
                issues.append((INCOMP, f"{slot['riser']} 미설치 — 해당 Riser 없이는 슬롯 사용 불가"))

        status = PASS if not issues else max((s for s, _ in issues), key=lambda s: SEVERITY[s])
        if status == PASS:
            issues = [(PASS, "장착 가능")]
        results.append({"slot": slot["id"], "label": slot["label"], "component": comp["name"] if comp else cid,
                        "component_id": cid, "status": status,
                        "issues": [{"status": s, "msg": m} for s, m in issues], "usable": slot_ok_for_use})
        if comp and status != INCOMP:
            effective.append(comp)

    # Double-width GPU는 인접 슬롯 1개를 점유하는 것으로 계산
    occupied_extra = sum(1 for c in effective if c.get("double_width"))
    return results, {"effective": effective, "occupied_extra": occupied_extra}


RAID_MIN = {"RAID0": 1, "RAID1": 2, "RAID5": 3, "RAID6": 4, "RAID10": 4}


def drives_from_cfg(server: dict, cfg: dict) -> list[dict]:
    """전면 베이 배치(cfg.bays) + BOSS → 기존 drives 목록 형식으로 정규화."""
    if "bays" not in cfg:
        return cfg.get("drives", [])
    opts = {d["id"]: d for d in server.get("drive_options", []) if isinstance(d, dict)}
    groups: dict[tuple, int] = {}
    for b in cfg["bays"].values():
        key = (b.get("drive"), b.get("role", "data"))
        groups[key] = groups.get(key, 0) + 1
    raid = cfg.get("raid", {})
    out = [{"model": opts.get(m, {}).get("name", m), "drive_id": m, "qty": q, "role": r, "raid": raid.get(r, "")}
           for (m, r), q in groups.items()]
    if cfg.get("boss"):
        out.append({"model": "BOSS-N1 M.2", "qty": 2, "role": "boot", "raid": "RAID1", "boss": True})
    return out


def check_bays(server: dict, cfg: dict) -> tuple[list[dict], list[dict]]:
    """전면 드라이브 베이 호환성 + RAID 구성 가능 여부."""
    bays_out, general = [], []
    if "bays" not in cfg:
        return bays_out, general
    bp = next((b for b in server.get("backplanes", []) if b["id"] == cfg.get("backplane")), None)
    if not bp:
        general.append({"status": REVIEW, "msg": "백플레인 미선택"}); return bays_out, general
    opts = {d["id"]: d for d in server.get("drive_options", []) if isinstance(d, dict)}
    for idx, b in sorted(cfg["bays"].items(), key=lambda kv: int(kv[0])):
        d = opts.get(b.get("drive"))
        issues = []
        if int(idx) >= bp["bays"]:
            issues.append((INCOMP, f"Bay {idx} 는 {bp['name']} 백플레인에 없음"))
        if d is None:
            issues.append((REVIEW, "카탈로그에 없는 드라이브"))
        else:
            if d["ff"] == "3.5" and bp["ff"] == "2.5":
                issues.append((INCOMP, "3.5\" 드라이브 → 2.5\" 베이 장착 불가"))
            if d["ff"] == "2.5" and bp["ff"] == "3.5":
                issues.append((REVIEW, "2.5\" 드라이브 → 3.5\" 베이: 하이브리드 캐리어 필요"))
            if d["iface"] == "NVMe" and "NVMe" not in bp["name"]:
                issues.append((INCOMP, "NVMe 드라이브 → NVMe 미지원 백플레인"))
        st = PASS if not issues else max((x for x, _ in issues), key=lambda x: SEVERITY[x])
        bays_out.append({"bay": int(idx), "drive": d["name"] if d else b.get("drive"), "role": b.get("role", "data"),
                         "status": st, "issues": [{"status": x, "msg": m} for x, m in issues] or [{"status": PASS, "msg": "장착 가능"}]})
    # RAID 그룹 검사
    for role, lvl in (cfg.get("raid") or {}).items():
        members = [b for b in cfg["bays"].values() if b.get("role", "data") == role]
        if not lvl or not members:
            continue
        n = len(members); need = RAID_MIN.get(lvl, 1)
        name = "Boot" if role == "boot" else "Data"
        if n < need or (lvl == "RAID1" and n != 2) or (lvl == "RAID10" and n % 2):
            general.append({"status": INCOMP, "msg": f"{name} {lvl} 구성 불가 — 디스크 {n}개 ({lvl} 조건: {'정확히 2개' if lvl == 'RAID1' else '짝수 4개 이상' if lvl == 'RAID10' else f'{need}개 이상'})"})
        if len({b.get("drive") for b in members}) > 1:
            general.append({"status": REVIEW, "msg": f"{name} {lvl} 그룹에 서로 다른 드라이브 모델 혼용"})
    return bays_out, general


def estimate_power(cfg: dict, effective: list[dict]) -> float:
    dimms = sum(int(m.get("qty", 0)) for m in cfg.get("memory", []))
    drives = sum(int(d.get("qty", 0)) for d in cfg.get("drives", []))
    return (BASE_POWER["base"] + BASE_POWER["cpu"] * int(cfg.get("cpu_count", 2))
            + BASE_POWER["dimm"] * dimms + BASE_POWER["drive"] * drives
            + sum(c.get("power_w", 0) for c in effective))


def summarize(server: dict, cfg: dict, slot_results: list[dict], extra: dict) -> dict:
    eff = extra["effective"]
    mem = sum(int(m.get("size_gb", 0)) * int(m.get("qty", 0)) for m in cfg.get("memory", []))
    dimms = sum(int(m.get("qty", 0)) for m in cfg.get("memory", []))
    nics = [c for c in eff if c["category"] in ("NIC", "OCP NIC")]
    fcs = [c for c in eff if c["category"] == "FC HBA"]
    usable_free = sum(1 for r in slot_results
                      if r["component"] is None and r["usable"] and r["slot"] != "OCP")
    free = max(0, usable_free - extra["occupied_extra"])
    psu_cnt = int(cfg.get("psu_count", 0)); psu_w = float(cfg.get("psu_watt", 0))
    raids = {d.get("raid", "") for d in cfg.get("drives", []) if d.get("role") == "boot" and d.get("qty", 0) >= RAID_MIN.get(d.get("raid", ""), 1)}
    return {
        "memory_gb": mem, "dimms": dimms,
        "cpu_sockets": int(cfg.get("cpu_count", 0)),
        "nics": nics, "fcs": fcs,
        "ocp_installed": any(c["form"] == "ocp" for c in eff),
        "raid_boot": sorted(r for r in raids if r),
        "psu_count": psu_cnt, "psu_watt": psu_w,
        "free_pcie": free,
        "gpu_count": sum(1 for c in eff if c["category"] == "GPU"),
        "power_est_w": estimate_power(cfg, eff),
    }


def _ports_at(cards, speed):
    return sum(c["ports"] for c in cards if c.get("speed_gb", 0) >= speed)


def check_requirements(reqs: list[dict], s: dict) -> list[dict]:
    out = []
    nic_speed = next((float(r["value"]) for r in reqs if r["key"] == "nic_speed_gb" and r["value"] not in ("", None)), 0)
    fc_speed = next((float(r["value"]) for r in reqs if r["key"] == "fc_speed_gb" and r["value"] not in ("", None)), 0)

    for r in reqs:
        k, op, v = r["key"], r["op"], r["value"]
        actual, status, note = "-", REVIEW, ""
        if r.get("status") == "review" or k == "manual":
            actual = "-"; status = REVIEW; note = r.get("note") or "정량 기준 불명확 — 담당자 확인"
            if k != "manual":
                actual = _actual_text(k, s, nic_speed, fc_speed)
            out.append(_row(r, actual, status, note)); continue
        if k == "memory_gb":
            actual = f"{s['memory_gb']}GB ({s['dimms']} DIMM)"; status = PASS if _cmp(s["memory_gb"], op, v) else FAIL
        elif k == "cpu_sockets":
            actual = f"{s['cpu_sockets']} Socket"; status = PASS if _cmp(s["cpu_sockets"], op, v) else FAIL
        elif k == "nic_speed_gb":
            best = max((c["speed_gb"] for c in s["nics"]), default=0)
            actual = f"최고 {best:g}GbE" if best else "NIC 없음"; status = PASS if best >= float(v) else FAIL
        elif k == "nic_ports":
            n = _ports_at(s["nics"], nic_speed)
            actual = f"{n}Port" + (f" (≥{nic_speed:g}GbE)" if nic_speed else ""); status = PASS if _cmp(n, op, v) else FAIL
        elif k == "fc_speed_gb":
            best = max((c["speed_gb"] for c in s["fcs"]), default=0)
            actual = f"최고 {best:g}Gb FC" if best else "FC HBA 없음"; status = PASS if best >= float(v) else FAIL
        elif k == "fc_ports":
            n = _ports_at(s["fcs"], fc_speed)
            actual = f"{n}Port" + (f" (≥{fc_speed:g}Gb)" if fc_speed else ""); status = PASS if _cmp(n, op, v) else FAIL
        elif k == "ocp_required":
            actual = "OCP NIC 장착" if s["ocp_installed"] else "OCP 미장착"; status = PASS if s["ocp_installed"] else FAIL
        elif k == "raid_level":
            actual = ", ".join(s["raid_boot"]) or "Boot RAID 없음"
            status = PASS if str(v).upper() in [x.upper() for x in s["raid_boot"]] else FAIL
        elif k == "dual_psu":
            actual = f"PSU {s['psu_watt']:g}W × {s['psu_count']}"
            if s["psu_count"] < 2: status = FAIL
            elif s["power_est_w"] > s["psu_watt"] * PSU_HEADROOM:
                status = REVIEW; note = f"예상 소비전력 {s['power_est_w']:.0f}W — 1대 장애 시 이중화 유지 불확실"
            else: status = PASS
        elif k == "psu_watt":
            actual = f"{s['psu_watt']:g}W"; status = PASS if _cmp(s["psu_watt"], op, v) else FAIL
        elif k == "free_pcie":
            actual = f"{s['free_pcie']}개"; status = PASS if _cmp(s["free_pcie"], op, v) else FAIL
            note = "CPU/Riser 조건상 사용 가능한 빈 슬롯 기준 (OCP 제외, DW GPU 인접 슬롯 차감)"
        elif k == "gpu_count":
            actual = f"{s['gpu_count']}EA"
            status = REVIEW if _cmp(s["gpu_count"], op, v) else FAIL
            note = "GPU는 전원/쿨링/Riser 추가 검토 필요" if status == REVIEW else ""
        else:
            note = "검증 규칙 없음"
        out.append(_row(r, actual, status, note))
    return out


def _actual_text(k, s, ns, fs):
    return {"memory_gb": f"{s['memory_gb']}GB", "nic_ports": f"{_ports_at(s['nics'], ns)}Port",
            "fc_ports": f"{_ports_at(s['fcs'], fs)}Port", "free_pcie": f"{s['free_pcie']}개",
            "dual_psu": f"PSU × {s['psu_count']}"}.get(k, "-")


def _row(r, actual, status, note):
    v = r["value"]
    if isinstance(v, bool): req = r["label"] + " 필요"
    elif v in ("", None): req = r["label"]
    else:
        vv = f"{float(v):g}" if isinstance(v, (int, float)) else v
        req = f"{r['label']} {'' if r['op'] == '=' else r['op'] + ' '}{vv}{r['unit']}"
    return {"id": r["id"], "requirement": req, "actual": actual, "status": status,
            "note": note, "source": r.get("source", "")}


def validate(server: dict, cfg: dict, reqs: list[dict], catalog: dict) -> dict:
    cfg = dict(cfg)
    bays, bay_general = check_bays(server, cfg)
    cfg["drives"] = drives_from_cfg(server, cfg)
    slots, extra = check_slots(server, cfg, catalog)
    s = summarize(server, cfg, slots, extra)
    general = list(bay_general)
    # 서버 레벨 점검
    if s["dimms"] > server["memory"]["dimm_slots"]:
        general.append({"status": INCOMP, "msg": f"DIMM {s['dimms']}개 > 슬롯 {server['memory']['dimm_slots']}개"})
    if s["dimms"] > server["memory"]["slots_per_cpu"] * s["cpu_sockets"]:
        general.append({"status": INCOMP, "msg": f"CPU {s['cpu_sockets']}개 기준 DIMM 최대 {server['memory']['slots_per_cpu'] * s['cpu_sockets']}개"})
    if s["cpu_sockets"] > server["cpu_sockets"]:
        general.append({"status": INCOMP, "msg": "CPU 수가 서버 소켓 수 초과"})
    if s["psu_count"] > server["psu_bays"]:
        general.append({"status": INCOMP, "msg": "PSU 수가 PSU Bay 초과"})
    if s["psu_watt"] and s["power_est_w"] > s["psu_watt"] * (s["psu_count"] or 1):
        general.append({"status": INCOMP, "msg": f"예상 소비전력 {s['power_est_w']:.0f}W > 총 PSU 용량"})
    elif s["psu_watt"] and s["power_est_w"] > s["psu_watt"] * PSU_HEADROOM:
        general.append({"status": REVIEW, "msg": f"예상 소비전력 {s['power_est_w']:.0f}W — PSU 1대({s['psu_watt']:g}W) 80% 초과, 이중화 시 확인 필요"})
    if s["gpu_count"]:
        general.append({"status": REVIEW, "msg": "GPU 장착: Dell 구성 가이드 기준 Fan/방열판/GPU Riser/전원케이블 조건 확인"})
    return {"requirements": check_requirements(reqs, s), "slots": slots, "bays": bays, "general": general,
            "summary": {k: v for k, v in s.items() if k not in ("nics", "fcs")}}
