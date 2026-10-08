import { useState } from "react";
import type { AiConflict, PasteLine, Requirement, RequirementGroup, ValidationResult } from "../types";
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
  onResolve: (line: number, use: "ai" | "rule") => void;
  onChange: (requirements: Requirement[]) => void;
  onMarkLine: (line: number, mark: "skip" | null) => void;
  onSplit: () => void;
  onKeepOne: () => void;
}

const STATUS_CLASS: Record<string, string> = { "충족": "ok", "미충족": "fail", "호환 불가": "incomp", "확인 필요": "review" };
/** 미충족 요구사항을 고칠 곳 */
export function fixFor(key: string): { label: string; request: Omit<FocusRequest, "n"> } | null {
  if (key.startsWith("fc_")) return { label: "FC HBA 추가", request: { kind: "slot", part: "fc" } };
  if (key.startsWith("nic_") || key === "ocp_required") return { label: "NIC 추가", request: { kind: "slot", part: "nic" } };
  if (key === "gpu_count") return { label: "GPU 추가", request: { kind: "slot", part: "gpu" } };
  if (key === "dual_psu" || key === "psu_watt") return { label: "PSU 변경", request: { kind: "slot", part: "psu" } };
  if (key === "raid_level" || key === "raid_controller") return { label: "RAID 변경", request: { kind: "bays", part: "raid" } };
  if (key.startsWith("disk_")) return { label: "디스크 추가", request: { kind: "bays" } };
  if (["memory_gb", "cpu_sockets", "cpu_cores"].includes(key)) return { label: "사양 수정", request: { kind: "spec", part: key === "memory_gb" ? "memory" : "cpu" } };
  return null;
}

export function formatRequirement(requirement: Requirement): string {
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

/** 항목 종류별 작은 아이콘 */
export function ItemIcon({ k }: { k: string }) {
  const kind = /psu/.test(k) ? "power" : /^cpu/.test(k) ? "cpu" : /^(disk|raid)/.test(k) ? "disk" : "box";
  return <svg className="item-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "power" ? <><path d="M12 2v9" /><path d="M7 4a9 9 0 1 0 10 0" /></>
      : kind === "cpu" ? <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" />{[8, 12, 16].map((n) => <path key={n} d={`M${n} 3v3M${n} 18v3M3 ${n}h3M18 ${n}h3`} />)}</>
      : kind === "disk" ? <><rect x="5" y="3" width="14" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8 17h.01M16 17h.01" /></>
      : <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h3M7 14h3M15 10h2M15 14h2" /></>}
  </svg>;
}

/** 화면에 보여 줄 항목 순서: 서버 → CPU → 메모리 → 디스크 → RAID → 네트워크 → 전원 */
const KEY_ORDER = ["rack_mount", "cpu_sockets", "cpu_cores", "memory_gb", "disk_count", "disk_size_gb", "disk_total_gb", "raid_level", "raid_controller",
  "nic_speed_gb", "nic_ports", "ocp_required", "fc_speed_gb", "fc_ports", "gpu_count", "free_pcie", "dual_psu", "psu_watt", "manual"];
export const keyRank = (key: string) => { const i = KEY_ORDER.indexOf(key); return i < 0 ? KEY_ORDER.length - 1 : i; };

/** AI 와 규칙이 다르게 읽은 줄: 기본은 AI 해석을 쓰고, 확인용으로 접어 둔다. 원문에서 확인 못 한 값이 있는 줄만 펼쳐 경고한다. */
export function ConflictList({ conflicts, onResolve, what }: { conflicts: AiConflict[]; onResolve: (line: number, use: "ai" | "rule") => void; what: string }) {
  if (!conflicts.length) return null;
  const risky = conflicts.filter((c) => c.unverified.length > 0);
  const quiet = conflicts.filter((c) => c.unverified.length === 0);
  const row = (c: AiConflict) => (
    <div key={c.line} className="cf">
      <div className="cf-text" title={c.text}>{c.text}</div>
      <div className="cf-opts">
        <button type="button" className={`opt ${c.using === "ai" ? "on" : ""}`} onClick={() => onResolve(c.line, "ai")}>AI: {c.ai}</button>
        <button type="button" className={`opt ${c.using === "rule" ? "on" : ""}`} disabled={!c.can_use_rule} onClick={() => onResolve(c.line, "rule")}>규칙: {c.rule ?? "읽지 못함"}</button>
      </div>
      {c.unverified.length > 0 && <div className="cf-why">원문에서 확인하지 못한 값: {c.unverified.join(", ")}</div>}
    </div>
  );
  return <>
    {risky.length > 0 && (
      <div className="warnlist aiconf" role="region" aria-label={`원문에서 확인하지 못한 ${what}`}>
        <b>⚠ 원문에서 확인하지 못한 값이 있는 {what} {risky.length}개</b> <span className="muted small">— 원문과 비교해 고르세요</span>
        {risky.map(row)}
      </div>
    )}
    {quiet.length > 0 && (
      <details className="aiconf-quiet">
        <summary className="muted small">AI가 규칙과 다르게 읽은 {what} {quiet.length}개 — AI 해석으로 반영됨 (필요하면 바꾸기)</summary>
        {quiet.map(row)}
      </details>
    )}
  </>;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 12);

export default function RequirementSection({
  group, busy, error,
  result, onFocus, onPaste, onResolve, onChange, onMarkLine, onSplit, onKeepOne,
}: Props) {
  const [showReview, setShowReview] = useState(false);
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
        {count("미충족") + count("호환 불가") > 0 && <span className="pill p-fail">미충족 {count("미충족") + count("호환 불가")}</span>}
        {count("확인 필요") > 0 && <button type="button" className="pill p-review pillbtn" aria-expanded={showReview} onClick={() => setShowReview(!showReview)}>확인 {count("확인 필요")} {showReview ? "▴" : "▾"}</button>}
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

  const sortedReqs = [...requirements].sort((a, b) => keyRank(a.key) - keyRank(b.key) || (a.line ?? 9999) - (b.line ?? 9999));
  const renderRow = (item: Requirement) => {
    const status = statusOf(item);
    const tone = STATUS_CLASS[status] || "review";
    const fix = status !== "충족" ? fixFor(item.key) : null;
    const row = result?.requirements.find((entry) => entry.id === item.id);
    const sources = item.sources?.length ? item.sources : item.source ? [item.source] : [];
    return (
      <li key={item.id} className={`reqrow s-${tone}`} tabIndex={editingId === item.id ? undefined : 0}>
        {editingId === item.id ? renderEdit(item) : (
          <>
            <span className="rq"><ItemIcon k={item.key} />{formatRequirement(item)}</span>
            <span className="ra">{row ? <>실제 <b>{row.actual}</b>{row.note ? ` · ${row.note}` : ""}</> : item.note || ""}</span>
            <span className="rs">
              <span className={`pill p-${tone}`}>{status}</span>
              {fix && <button type="button" className="fix" onClick={() => onFocus({ ...fix.request, need: formatRequirement(item) })}>{fix.label}</button>}
            </span>
            <span className="rtools">
              <button className="ico" aria-label="고치기" onClick={() => { setEditingId(item.id); setEditingKey(item.key); }}>✎</button>
              <button className="ico" aria-label="삭제" onClick={() => remove(item.id)}>✕</button>
            </span>
            {!!sources.length && <span className="rsrc" role="tooltip"><small>원문</small>{sources.map((source, index) => <span key={index}>“{source}”</span>)}</span>}
          </>
        )}
      </li>
    );
  };
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
      {pasteMode && <div className="pad">{pasteBox(pasteMode)}</div>}
      {group.ai?.notice && <p className="warn small pad" role="status">{group.ai.notice}</p>}
      <ConflictList conflicts={group.ai?.conflicts || []} onResolve={onResolve} what="줄" />
      {n("warn") > 0 && (
        <div className="warnlist" role="region" aria-label="읽지 못한 줄">
          <b>⚠ 읽지 못한 줄 {n("warn")}개</b> <span className="muted small">— 항목으로 추가하거나 제외하세요</span>
          {lines.filter((_, index) => states[index] === "warn").map((line) => (
            <div key={line.n} className="wl">
              <span className="wl-text" title={line.hint}>{line.text}</span>
              <select aria-label="항목으로 추가" value="" onChange={(event) => { if (event.target.value) addFor(line, event.target.value); }}>
                <option value="">항목 ▾</option>
                {Object.entries(KEY_DEFS).filter(([key]) => key !== "manual").map(([key, [label, unit]]) => <option key={key} value={key}>{label}{unit ? ` (${unit})` : ""}</option>)}
              </select>
              <button type="button" className="lnk small" onClick={() => addFor(line, "manual", true)}>수기 검토</button>
              <button type="button" className="lnk small" onClick={() => onMarkLine(line.n, "skip")}>제외</button>
            </div>
          ))}
        </div>
      )}
      {showReview && count("확인 필요") > 0 && (
        <div className="reviewbox" role="region" aria-label="수기 검토가 필요한 요구사항">
          <b>수기 검토 필요 {count("확인 필요")}개</b> <span className="muted small">— 자동 판정할 수 없어 사람이 확인해야 하는 항목입니다</span>
          <ul className="reqrows">{sortedReqs.filter((item) => statusOf(item) === "확인 필요").map(renderRow)}</ul>
        </div>
      )}
      <ul className="reqrows">
        {(group.model_hint || group.suggested_server) && (
          <li className="reqrow s-info">
            <span className="rq"><ItemIcon k="model" />서버 모델 · {group.model_hint || "미기재"}</span>
            <span className="ra">{group.suggested_server ? "서버 모델 자동 선택됨" : "서버 카탈로그에 없는 모델 — 위에서 직접 고르세요"}</span>
          </li>
        )}
        {sortedReqs.filter((item) => statusOf(item) !== "확인 필요").map(renderRow)}
        {!requirements.length && <li className="reqempty muted">인식된 요구사항이 없습니다. 직접 추가하거나 원문을 확인하세요.</li>}
      </ul>
      <div className="reqfoot">
        <details className="linefold">
          <summary>원문 보기 ({lines.length}줄{n("skip") ? ` · 제외 ${n("skip")}` : ""})</summary>
          <ul className="plines">
            {lines.map((line, index) => {
              const state = states[index];
              return (
                <li key={line.n} className={`pl pl-${state}`}>
                  <span className="pl-ic" aria-hidden="true">{state === "req" || state === "part" ? "✓" : state === "warn" ? "⚠" : state === "head" ? "" : "–"}</span>
                  <div className="pl-text">{line.text}
                    {state === "skip" && <span className="pl-tag">{line.status === "skip" ? line.label?.split(" — ")[0] || "제외" : "제외"}</span>}
                    {state === "skip" && marks[line.n] === "skip" && <button type="button" className="lnk small" onClick={() => onMarkLine(line.n, null)}>되돌리기</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
        <span className="reqfoot-act">
          <button type="button" className="lnk" onClick={() => addFor(null)}>+ 직접 추가</button>
          <button type="button" className="lnk" onClick={() => { setPasted(""); setPasteMode("append"); }}>더 붙여넣기</button>
          <button type="button" className="lnk" onClick={() => { setPasted(group.text || ""); setPasteMode("replace"); }}>다시 붙여넣기</button>
        </span>
      </div>
      {!!group.evidence?.length && !group.proposed && group.notes?.length ? (
        <p className="muted small pad">⚠ {group.notes.join(" · ")}</p>
      ) : null}
    </section>
  );
}
