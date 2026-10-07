import { useState } from "react";
import type { PasteLine, Requirement, RequirementGroup, ValidationResult } from "../types";
import type { FocusRequest } from "./ConfigSection";

const KEY_DEFS: Record<string, [string, string]> = {
  memory_gb: ["Memory", "GB"],
  cpu_sockets: ["CPU", "Socket"],
  cpu_cores: ["CPU Core", "Core"],
  disk_count: ["Disk", "EA"],
  disk_size_gb: ["Disk Size", "GB"],
  disk_total_gb: ["Disk Total", "GB"],
  raid_level: ["RAID", ""],
  raid_controller: ["RAID Controller", ""],
  rack_mount: ["Rack Type", ""],
  nic_speed_gb: ["NIC Speed", "GbE"],
  nic_ports: ["NIC Port", "Port"],
  fc_speed_gb: ["FC Speed", "Gb"],
  fc_ports: ["FC Port", "Port"],
  ocp_required: ["OCP 3.0", ""],
  dual_psu: ["Dual PSU", ""],
  psu_watt: ["PSU Capacity", "W"],
  free_pcie: ["Free PCIe Slot", "EA"],
  gpu_count: ["GPU", "EA"],
  manual: ["수기 검토", ""],
};
const BOOLEAN_KEYS = new Set(["ocp_required", "dual_psu", "raid_controller", "rack_mount"]);
/** 칩 뒤에 붙여 보여줄 짧은 조건 (CPU당 / Boot / 10GbE 이상 포트) */
const SHOWN_NOTES = /^(CPU당|Boot|[\d.]+GbE 이상 포트)$/;

interface Props {
  group: RequirementGroup;
  busy: boolean;
  error: string;
  result: ValidationResult | null;
  onFocus: (request: Omit<FocusRequest, "n">) => void;
  onPaste: (text: string, mode: "replace" | "append") => void;
  onChange: (requirements: Requirement[]) => void;
  onMarkLine: (line: number, mark: "skip" | null) => void;
  onSplit: () => void;
  onKeepOne: () => void;
}

const STATUS_CLASS: Record<string, string> = { "충족": "ok", "미충족": "fail", "호환 불가": "incomp", "확인 필요": "review" };
/** 미충족 요구사항을 고칠 곳 */
function fixFor(key: string): { label: string; request: Omit<FocusRequest, "n"> } | null {
  if (key.startsWith("fc_")) return { label: "FC HBA 추가", request: { kind: "slot", part: "fc" } };
  if (key.startsWith("nic_") || key === "ocp_required") return { label: "NIC 추가", request: { kind: "slot", part: "nic" } };
  if (key === "gpu_count") return { label: "GPU 추가", request: { kind: "slot", part: "gpu" } };
  if (key === "dual_psu" || key === "psu_watt") return { label: "PSU 변경", request: { kind: "slot", part: "psu" } };
  if (key === "raid_level" || key === "raid_controller") return { label: "RAID 변경", request: { kind: "bays" } };
  if (key.startsWith("disk_")) return { label: "디스크 추가", request: { kind: "bays" } };
  if (["memory_gb", "cpu_sockets", "cpu_cores"].includes(key)) return { label: "사양 수정", request: { kind: "spec" } };
  return null;
}

function formatRequirement(requirement: Requirement): string {
  const [label, unit] = KEY_DEFS[requirement.key] || [requirement.label, requirement.unit || ""];
  if (requirement.key === "manual") return requirement.label && requirement.label !== "수기 검토" ? `수기 검토 · ${requirement.label}` : "수기 검토";
  const note = requirement.note && SHOWN_NOTES.test(requirement.note) ? ` (${requirement.note})` : "";
  if (BOOLEAN_KEYS.has(requirement.key) || requirement.value === true) return `${label} 필요${note}`;
  if (requirement.value === "" || requirement.value == null) return label;
  if (requirement.key === "raid_level") return `${requirement.value}${note}`;
  let value: string | number = typeof requirement.value === "number" ? +requirement.value.toFixed(2) : String(requirement.value);
  let shownUnit = unit;
  if (unit === "GB" && typeof value === "number" && value >= 1000 && requirement.key.startsWith("disk_")) { value = +(value / 1000).toFixed(2); shownUnit = "TB"; }
  const operator = ({ ">=": "≥", "<=": "≤", "=": "", "?": "" } as Record<string, string>)[requirement.op] ?? requirement.op;
  return `${label} ${operator ? `${operator} ` : ""}${value}${shownUnit ? ` ${shownUnit}` : ""}${note}`;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 12);

export default function RequirementSection({
  group, busy, error,
  result, onFocus, onPaste, onChange, onMarkLine, onSplit, onKeepOne,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState("");
  const [pasteMode, setPasteMode] = useState<"replace" | "append" | null>(null);
  const [pasted, setPasted] = useState("");
  const requirements = group.requirements || [];
  const marks = group.line_marks || {};

  const statusOf = (item: Requirement) => {
    if (item.status === "review" || item._new || item.key === "manual") return "확인 필요";
    return result?.requirements.find((row) => row.id === item.id)?.status || "확인 필요";
  };
  const actualOf = (item: Requirement) => {
    const row = result?.requirements.find((entry) => entry.id === item.id);
    return row ? `실제 ${row.actual}${row.note ? ` · ${row.note}` : ""}` : item.note || "";
  };
  const count = (status: string) => requirements.filter((item) => statusOf(item) === status).length;

  const update = (id: string, values: Partial<Requirement>) =>
    onChange(requirements.map((item) => item.id === id ? { ...item, ...values, _user: true } : item));
  const remove = (id: string) => {
    onChange(requirements.filter((item) => item.id !== id));
    if (editingId === id) setEditingId(null);
  };
  const addFor = (line: PasteLine | null, key = "memory_gb", manual = false) => {
    const id = newId();
    const [label, unit] = KEY_DEFS[key];
    onChange([...requirements, {
      id, key, label: manual ? (line?.text.slice(0, 80) || "수기 검토") : label, unit, op: manual ? "?" : ">=", value: manual ? "" : "",
      source: line?.text || "(직접 추가)", status: manual ? "review" : "auto", note: manual ? "정량 기준 없음 → 담당자 확인" : "",
      line: line?.n, _new: !manual, _user: true,
    }]);
    if (!manual) { setEditingId(id); setEditingKey(key); }
  };

  const saveEdit = (item: Requirement, form: HTMLFormElement) => {
    const values = new FormData(form);
    const key = String(values.get("key"));
    const rawValue = String(values.get("value") ?? "").trim();
    const [label, unit] = KEY_DEFS[key] || [item.label, item.unit || ""];
    const value: Requirement["value"] = BOOLEAN_KEYS.has(key)
      ? true
      : rawValue !== "" && Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue;
    update(item.id, {
      key, label: key === "manual" ? (item.key === "manual" ? item.label : "수기 검토") : label, unit,
      op: String(values.get("op")), value,
      status: values.has("review") || key === "manual" ? "review" : "auto", _new: false,
    });
    setEditingId(null);
    setEditingKey("");
  };

  const renderEdit = (item: Requirement) => (
    <form className="reqedit" onSubmit={(event) => { event.preventDefault(); saveEdit(item, event.currentTarget); }}>
      <select name="key" value={editingKey} onChange={(event) => setEditingKey(event.target.value)} aria-label="항목">
        {Object.entries(KEY_DEFS).map(([key, [label, unit]]) => <option key={key} value={key}>{label}{unit ? ` (${unit})` : ""}</option>)}
      </select>
      <select name="op" defaultValue={item.op === "?" ? ">=" : item.op} aria-label="조건">
        {[">=", "=", "<="].map((operator) => <option key={operator} value={operator}>{operator}</option>)}
      </select>
      <input name="value" aria-label="값" defaultValue={typeof item.value === "boolean" ? "" : item.value ?? ""} disabled={BOOLEAN_KEYS.has(editingKey) || editingKey === "manual"} placeholder={BOOLEAN_KEYS.has(editingKey) ? "필요" : "값"} autoFocus />
      <label className="chk"><input type="checkbox" name="review" defaultChecked={item.status === "review"} /> 확인 필요</label>
      <button className="btn small" type="submit">저장</button>
      <button className="btn ghost small" type="button" onClick={() => {
        if (item._new) remove(item.id);
        setEditingId(null);
        setEditingKey("");
      }}>취소</button>
      {!item._new && <button className="btn ghost small danger" type="button" onClick={() => remove(item.id)}>삭제</button>}
    </form>
  );

  const chip = (item: Requirement) => {
    const status = statusOf(item);
    const tone = STATUS_CLASS[status] || "review";
    const fix = status !== "충족" ? fixFor(item.key) : null;
    return (
      <span key={item.id} className={`rchip c-${tone}`}>
        <button type="button" className="rchip-main" title={`${status} · ${actualOf(item)} — 눌러서 고치기`}
          onClick={() => { setEditingId(item.id); setEditingKey(item.key); }}>
          {formatRequirement(item)}
          {status !== "충족" && status !== "확인 필요" && <span className="rchip-act"> · {actualOf(item).replace(/^실제 /, "") || status}</span>}
        </button>
        {fix && <button type="button" className="rchip-fix" onClick={() => onFocus(fix.request)}>{fix.label}</button>}
      </span>
    );
  };

  const pasteBox = (mode: "replace" | "append" | "first") => (
    <div className={`pastebox ${mode === "first" ? "first" : ""}`}>
      <textarea
        aria-label="요구사항 붙여넣기"
        rows={mode === "first" ? 10 : 6}
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        placeholder={mode === "append" ? "추가할 내용을 붙여넣으세요 — 지금 내용 뒤에 붙습니다"
          : "고객 요구사항을 긁어서 여기에 붙여넣으세요 (Ctrl+V)\n\nCPU: 2소켓, 코어 32개 이상\n메모리 512GB 이상\nSSD 1.92TB 4개 이상 RAID5\n10GbE 2포트 이상, FC 32Gb 2포트"}
        autoFocus={mode !== "first"}
      />
      <div className="row">
        <button type="button" className="btn" disabled={busy || !pasted.trim()} onClick={() => {
          onPaste(pasted, mode === "append" ? "append" : "replace");
          setPasted("");
          setPasteMode(null);
        }}>{busy ? "분석 중…" : mode === "append" ? "추가해서 분석" : "분석"}</button>
        {mode !== "first" && <button type="button" className="btn ghost" onClick={() => { setPasteMode(null); setPasted(""); }}>취소</button>}
        <span className="muted small">견적은 오른쪽 칸에 붙여넣으세요 · 외부로 보내지 않습니다</span>
      </div>
    </div>
  );

  const head = (
    <div className="cardhead">
      <h2>요구사항 <span className="muted">· {group.name}{group.quantity ? ` ×${group.quantity}` : ""}</span></h2>
      <div className="counts">
        {count("충족") > 0 && <span className="pill p-ok">충족 {count("충족")}</span>}
        {count("미충족") + count("호환 불가") > 0 && <span className="pill p-fail">미충족 {count("미충족") + count("호환 불가")}</span>}
        {count("확인 필요") > 0 && <span className="pill p-review">확인 {count("확인 필요")}</span>}
      </div>
    </div>
  );

  if (!group.text && !requirements.length) return (
    <section id="s1" className="card reqcard">
      {head}
      <div className="pad">{pasteBox("first")}</div>
      {error && <p className="warn pad" role="alert">{error}</p>}
    </section>
  );

  const lines = group.lines || [];
  const lineState = (line: PasteLine) => {
    const reqs = requirements.filter((item) => item.line === line.n || item.lines?.includes(line.n));
    if (reqs.length) return "req";
    if (line.status === "part" || line.status === "head") return line.status;
    if (line.status === "skip" || marks[line.n] === "skip") return "skip";
    return "warn";
  };
  const states = lines.map(lineState);
  const n = (state: string) => states.filter((item) => item === state).length;
  const loose = requirements.filter((item) => item.line == null || !lines.some((line) => line.n === item.line));

  return (
    <section id="s1" className="card reqcard">
      {head}
      {error && <p className="warn pad" role="alert">{error}</p>}
      {!!group.split?.length && (
        <div className="splitbar pad" role="region" aria-label="서버 나누기 제안">
          <b>서버가 {group.split.length}개로 보입니다</b> — {group.split.map((item) => `${item.name}${item.quantity ? ` ×${item.quantity}` : ""} (${item.lines?.length || 0}줄)`).join(" · ")}
          {!!group.common_lines && <div className="muted small">첫 서버 제목 앞의 {group.common_lines}줄은 모든 서버에 공통으로 넣습니다</div>}
          <div className="row">
            <button type="button" className="btn" onClick={onSplit}>{group.split.length}개 탭으로 나누기</button>
            <button type="button" className="btn ghost" onClick={onKeepOne}>한 서버로 두기</button>
          </div>
        </div>
      )}
      <div className="pad srcbar">
        <b>붙여넣은 내용 {lines.length}줄</b>
        <span className="muted small">
          {[n("req") && `요구사항 ${n("req")}`, n("part") && `견적 품목 ${n("part")}`, n("warn") && `확인 필요 ${n("warn")}`, n("skip") && `검증 제외 ${n("skip")}`].filter(Boolean).join(" · ")}
        </span>
        <span className="srcbar-act">
          <button type="button" className="lnk" onClick={() => { setPasted(""); setPasteMode("append"); }}>더 붙여넣기</button>
          <button type="button" className="lnk" onClick={() => { setPasted(group.text || ""); setPasteMode("replace"); }}>다시 붙여넣기</button>
        </span>
      </div>
      {pasteMode && <div className="pad">{pasteBox(pasteMode)}</div>}
      {n("warn") > 0 && <p className="pad warnline" role="status">⚠ 자동으로 읽지 못한 줄이 {n("warn")}개 있습니다 — 아래에서 항목으로 추가하거나 '검증 대상 아님'으로 정하세요</p>}
      {/* 견적은 위 '견적 구성'이 요약이라 품목 줄은 접어 둔다 (읽지 못한 줄이 있으면 펼침) */}
      <details className="linefold" open>
      <summary className="pad muted small">붙여넣은 줄 보기</summary>
      <ul className="plines">
        {lines.map((line, index) => {
          const state = states[index];
          const reqs = requirements.filter((item) => item.line === line.n);
          return (
            <li key={line.n} className={`pl pl-${state}`}>
              <span className="pl-ic" aria-hidden="true">{state === "req" || state === "part" ? "✓" : state === "warn" ? "⚠" : state === "head" ? "" : "–"}</span>
              <div className="pl-body">
                <div className="pl-text">{line.text}
                  {state === "skip" && <span className="pl-tag">{line.status === "skip" ? line.label?.split(" · ")[0] || "검증 대상 아님" : "검증 대상 아님"}</span>}
                  {state === "skip" && marks[line.n] === "skip" && <button type="button" className="lnk small" onClick={() => onMarkLine(line.n, null)}>되돌리기</button>}
                </div>
                {!!reqs.length && <div className="pl-chips">{reqs.map(chip)}</div>}
                {state === "part" && <div className="pl-chips"><span className="rchip c-part">{line.label}</span></div>}
                {state === "warn" && <>
                  <div className="pl-hint">{line.hint || "자동으로 읽지 못한 줄입니다"} — 직접 정해 주세요</div>
                  <div className="pl-acts">
                    <select aria-label="항목으로 추가" value="" onChange={(event) => { if (event.target.value) addFor(line, event.target.value); }}>
                      <option value="">항목으로 추가 ▾</option>
                      {Object.entries(KEY_DEFS).filter(([key]) => key !== "manual").map(([key, [label, unit]]) => <option key={key} value={key}>{label}{unit ? ` (${unit})` : ""}</option>)}
                    </select>
                    <button type="button" className="btn ghost small" onClick={() => addFor(line, "manual", true)}>수기 검토로 남기기</button>
                    <button type="button" className="btn ghost small" onClick={() => onMarkLine(line.n, "skip")}>검증 대상 아님</button>
                  </div>
                </>}
                {reqs.some((item) => item.id === editingId) && renderEdit(reqs.find((item) => item.id === editingId)!)}
              </div>
            </li>
          );
        })}
      </ul>
      </details>
      {(loose.length > 0 || !lines.length) && (
        <div className="pad loose">
          <b className="small">{lines.length ? "직접 추가한 항목" : "요구사항"}</b>
          <div className="pl-chips">{loose.map(chip)}</div>
          {loose.some((item) => item.id === editingId) && renderEdit(loose.find((item) => item.id === editingId)!)}
          {!loose.length && <span className="muted small">인식된 요구사항이 없습니다.</span>}
        </div>
      )}
      <button className="addreq" onClick={() => addFor(null)}>+ 요구사항 직접 추가</button>
      {!!group.evidence?.length && !group.proposed && group.notes?.length ? (
        <p className="muted small pad">⚠ {group.notes.join(" · ")}</p>
      ) : null}
    </section>
  );
}
