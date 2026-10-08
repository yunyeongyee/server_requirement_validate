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
  disk_media: ["Disk Type", ""],
  disk_iface: ["Disk Interface", ""],
  cpu_ghz: ["CPU Clock", "GHz"],
  memory_type: ["Memory Type", ""],
  nic_media: ["NIC Interface", ""],
  os_spec: ["OS", ""],
  spec_note: ["기타 조건", ""],
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
  /** 모델이 확정되기 전에는 판정하지 않는다 (결과 '대기') */
  modelConfirmed?: boolean;
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

const STATUS_CLASS: Record<string, string> = {
  "대기": "pending", "충족": "ok", "미충족": "fail", "호환 불가": "incomp", "확인 필요": "review" };
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
const KEY_ORDER = ["rack_mount", "cpu_sockets", "cpu_ghz", "cpu_cores", "memory_gb", "memory_type", "disk_media", "disk_iface", "disk_count", "disk_size_gb", "disk_total_gb", "raid_level", "raid_controller",
  "nic_speed_gb", "nic_media", "nic_ports", "ocp_required", "fc_speed_gb", "fc_ports", "gpu_count", "free_pcie", "dual_psu", "psu_watt", "os_spec", "spec_note", "manual"];
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

const GROUPS: Record<string, string> = {
  rack_mount: "Rack", cpu_sockets: "CPU", cpu_cores: "CPU", cpu_ghz: "CPU", disk_media: "Disk", disk_iface: "Disk", memory_type: "Memory", nic_media: "NIC", os_spec: "OS", spec_note: "기타 조건", memory_gb: "Memory", disk_count: "Disk", disk_size_gb: "Disk", disk_total_gb: "Disk",
  raid_level: "RAID", raid_controller: "RAID", nic_speed_gb: "NIC", nic_ports: "NIC Port", ocp_required: "OCP", fc_speed_gb: "FC HBA", fc_ports: "FC Port",
  gpu_count: "GPU", free_pcie: "PCIe", dual_psu: "PSU", psu_watt: "PSU", manual: "수기 검토",
};
const reqGroup = (key: string) => GROUPS[key] || KEY_DEFS[key]?.[0] || key;
/** '요구 조건' 칸: 항목명을 뺀 조건만 (16 Core 이상 · 2 EA 이상 · 이중화) */
export function reqCondition(item: Requirement): string {
  if (BOOLEAN_KEYS.has(item.key) || item.value === true) return item.key === "dual_psu" ? "이중화" : item.key === "rack_mount" ? "랙 장착형" : "필요";
  if (item.key === "raid_level") return `${item.value}`;
  if (item.value === "" || item.value == null) return item.label || "";
  const [, unit] = KEY_DEFS[item.key] || ["", item.unit || ""];
  let value: string | number = typeof item.value === "number" ? +item.value.toFixed(2) : String(item.value);
  let shown = unit;
  if (unit === "GB" && typeof value === "number" && value >= 1000 && item.key.startsWith("disk_")) { value = +(value / 1000).toFixed(2); shown = "TB"; }
  const prefix = item.key === "disk_size_gb" ? "디스크당 " : item.key === "disk_total_gb" ? "합계 " : item.key === "psu_watt" ? "" : "";
  const op = ({ ">=": "이상", "<=": "이하", "=": "", "?": "" } as Record<string, string>)[item.op] ?? item.op;
  const note = item.note && SHOWN_NOTES.test(item.note) ? ` (${item.note})` : "";
  return `${prefix}${value}${shown ? ` ${shown}` : ""}${op ? ` ${op}` : ""}${note}`;
}

/** 표의 한 줄 = 한 부품 종류. 안에 든 조건은 각각 따로 검증하고, 하나라도 미충족/확인 필요면 그 줄도 그렇게 표시한다 */
const GROUP_DEFS: Array<{ id: string; label: string; ik: string; keys: string[] }> = [
  { id: "rack", label: "Rack", ik: "rack_mount", keys: ["rack_mount"] },
  { id: "cpu", label: "CPU", ik: "cpu_sockets", keys: ["cpu_sockets", "cpu_ghz", "cpu_cores"] },
  { id: "mem", label: "Memory", ik: "memory_gb", keys: ["memory_gb", "memory_type"] },
  { id: "disk", label: "Disk", ik: "disk_count", keys: ["disk_media", "disk_iface", "disk_size_gb", "disk_total_gb", "disk_count"] },
  { id: "raid", label: "RAID", ik: "raid_level", keys: ["raid_level", "raid_controller"] },
  { id: "nic", label: "NIC", ik: "nic_speed_gb", keys: ["nic_speed_gb", "nic_media", "nic_ports"] },
  { id: "ocp", label: "OCP", ik: "ocp_required", keys: ["ocp_required"] },
  { id: "fc", label: "FC HBA", ik: "fc_speed_gb", keys: ["fc_speed_gb", "fc_ports"] },
  { id: "gpu", label: "GPU", ik: "gpu_count", keys: ["gpu_count"] },
  { id: "pcie", label: "PCIe", ik: "free_pcie", keys: ["free_pcie"] },
  { id: "psu", label: "PSU", ik: "dual_psu", keys: ["dual_psu", "psu_watt"] },
  { id: "os", label: "OS", ik: "os", keys: ["os_spec"] },
  { id: "etc", label: "기타 조건", ik: "spec_note", keys: ["spec_note"] },
];
const gbText = (gb: number) => gb >= 1000 ? `${+(gb / 1000).toFixed(2)}TB` : `${gb}GB`;
/** 그룹의 요구 조건 한 줄. 원문에 없는 조건은 추정하지 않고 '미지정'으로 적는다 */
function groupCondition(id: string, items: Requirement[]): string {
  const by = (key: string) => items.find((item) => item.key === key);
  const op = (item: Requirement) => ({ ">=": " 이상", "<=": " 이하", "=": "", "?": "" } as Record<string, string>)[item.op] ?? "";
  const num = (item: Requirement) => typeof item.value === "number" ? +item.value.toFixed(2) : item.value;
  const parts: string[] = [];
  if (id === "disk") {
    const media = by("disk_media"), iface = by("disk_iface");
    parts.push(media || iface ? [iface?.value, media?.value].filter(Boolean).join(" ") : "종류 미지정");
    const size = by("disk_size_gb"), total = by("disk_total_gb");
    if (size) parts.push(`디스크당 ${gbText(Number(size.value))}${op(size)}`);
    if (total) parts.push(`합계 ${gbText(Number(total.value))}${op(total)}${total.note ? ` (${total.note})` : ""}`);
    if (!size && !total) parts.push("용량 미지정");
    const count = by("disk_count");
    parts.push(count ? `${num(count)}개${op(count)}` : "수량 미지정");
    return parts.join(" · ");
  }
  if (id === "nic" || id === "fc") {
    const speed = by(id === "nic" ? "nic_speed_gb" : "fc_speed_gb"), ports = by(id === "nic" ? "nic_ports" : "fc_ports");
    parts.push(speed ? `${num(speed)}${id === "nic" ? "GbE" : "Gb"}${op(speed)}` : "속도 미지정");
    const media = by("nic_media");
    if (media) parts.push(String(media.value));
    parts.push(ports ? `${num(ports)} Port${op(ports)}${ports.at_speed ? ` (${ports.at_speed}G 이상 포트)` : ""}` : "포트 수 미지정");
    return parts.join(" · ");
  }
  if (id === "etc") return items.map((item) => String(item.value)).join(" · ");
  const order = GROUP_DEFS.find((def) => def.id === id)?.keys || [];
  return order.map((key) => by(key)).filter((item): item is Requirement => !!item).map((item) => reqCondition(item)).join(" · ");
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 12);

export default function RequirementSection({
  group, busy, error,
  result, modelConfirmed = true, onFocus, onPaste, onResolve, onChange, onMarkLine, onSplit, onKeepOne,
}: Props) {
  const [showReview, setShowReview] = useState(false);
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState("");
  const [pasteMode, setPasteMode] = useState<"replace" | "append" | null>(null);
  const [pasted, setPasted] = useState("");
  const requirements = group.requirements || [];
  const marks = group.line_marks || {};

  const statusOf = (item: Requirement) => {
    if (item.status === "review" || item._new || item.key === "manual") return "확인 필요";
    if (!modelConfirmed) return "대기";
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

  const pasteBox = (mode: "replace" | "append" | "first") => busy ? (
    <div className="pastebusy" role="status"><span className="spin" aria-hidden="true" />요구사항을 읽는 중… 입력한 내용은 실패하면 그대로 다시 보여 드립니다.</div>
  ) : (
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
          if (mode !== "first") { setPasted(""); setPasteMode(null); }
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
    const sources = item.sources?.length ? item.sources : item.source ? [item.source] : [];
    if (editingId === item.id) return <tr key={item.id} className="editing"><td colSpan={4}>{renderEdit(item)}</td></tr>;
    return (
      <tr key={item.id} className={`s-${tone}`} title={sources.length ? `원문: ${sources.join(" / ")}` : undefined}>
        <th scope="row"><span className="cmp-item"><ItemIcon k={item.key} />{reqGroup(item.key)}</span></th>
        <td>{reqCondition(item)}</td>
        <td className="c"><span className={`pill p-${tone}`}>{status}</span></td>
        <td className="act">
          {fix && <button type="button" className="fix" onClick={() => onFocus({ ...fix.request, need: formatRequirement(item) })}>{fix.label}</button>}
          <span className="rtools-inline">
            <button className="ico" aria-label="고치기" onClick={() => { setEditingId(item.id); setEditingKey(item.key); }}>✎</button>
            <button className="ico" aria-label="삭제" onClick={() => remove(item.id)}>✕</button>
          </span>
        </td>
      </tr>
    );
  };
  const aggregate = (items: Requirement[]) => {
    const all = items.map(statusOf);
    return all.some((x) => x === "미충족" || x === "호환 불가") ? (all.includes("호환 불가") && !all.includes("미충족") ? "호환 불가" : "미충족")
      : all.includes("확인 필요") ? "확인 필요" : all.includes("대기") ? "대기" : "충족";
  };
  const renderGroup = (def: typeof GROUP_DEFS[number]) => {
    const items = sortedReqs.filter((item) => def.keys.includes(item.key) && item.key !== "manual");
    if (!items.length) return null;
    const status = aggregate(items);
    const tone = STATUS_CLASS[status] || "review";
    const open = openGroups.includes(def.id);
    const bad = items.find((item) => ["미충족", "호환 불가"].includes(statusOf(item))) || items.find((item) => statusOf(item) === "확인 필요");
    const fix = status !== "충족" && bad ? fixFor(bad.key) : null;
    return [
      <tr key={def.id} className={`s-${tone}`}>
        <th scope="row"><span className="cmp-item"><button type="button" className="caret" aria-expanded={open} aria-label={`${def.label} 조건 ${open ? "접기" : "펼치기"}`} onClick={() => setOpenGroups(open ? openGroups.filter((x) => x !== def.id) : [...openGroups, def.id])}>{open ? "▾" : "▸"}</button><ItemIcon k={def.ik} />{def.label}</span></th>
        <td>{groupCondition(def.id, items)}</td>
        <td className="c"><span className={`pill p-${tone}`}>{status}</span></td>
        <td className="act">{fix && bad && <button type="button" className="fix" onClick={() => onFocus({ ...fix.request, need: `${def.label} ${groupCondition(def.id, items)}` })}>{fix.label}</button>}</td>
      </tr>,
      ...(open ? items.map((item) => {
        const row = result?.requirements.find((entry) => entry.id === item.id);
        const st = statusOf(item);
        const t = STATUS_CLASS[st] || "review";
        if (editingId === item.id) return <tr key={item.id} className="editing"><td colSpan={4}>{renderEdit(item)}</td></tr>;
        return (
          <tr key={item.id} className="subrow">
            <th scope="row">{KEY_DEFS[item.key]?.[0] || item.label}</th>
            <td>{reqCondition(item)}{row ? <small>{row.actual && row.actual !== "-" ? `실제 ${row.actual}` : ""}{row.actual && row.actual !== "-" && row.note ? " · " : ""}{row.note}</small> : item.note ? <small>{item.note}</small> : null}
              {item.source && <small className="src">원문: “{item.source}”</small>}
              {item.waiver && <small className="waive">대체 승인 기록 · 근거: {item.waiver.basis}</small>}</td>
            <td className="c"><span className={`pill p-${t}`}>{st}</span></td>
            <td className="act"><span className="rtools-inline always">
              {!item.waiver && ["미충족", "확인 필요"].includes(st) && item.key !== "spec_note" && item.key !== "os_spec" && <button type="button" className="lnk small" title="고객이 다른 사양으로 대체하는 것을 승인한 경우에만 — 근거를 함께 기록합니다" onClick={() => {
                const basis = window.prompt("대체를 승인한 근거를 입력하세요 (예: 고객 이메일 2026-10-08, 담당자 확인)");
                if (basis && basis.trim()) update(item.id, { waiver: { basis: basis.trim(), at: new Date().toISOString() } });
              }}>대체 승인…</button>}
              {item.waiver && <button type="button" className="lnk small" onClick={() => update(item.id, { waiver: undefined })}>승인 취소</button>}
              <button className="ico" aria-label="고치기" onClick={() => { setEditingId(item.id); setEditingKey(item.key); }}>✎</button>
              <button className="ico" aria-label="삭제" onClick={() => remove(item.id)}>✕</button>
            </span></td>
          </tr>
        );
      }) : []),
    ];
  };
  const softwareLines = (group.lines || []).filter((line) => line.status === "skip" && (line.label?.startsWith("OS·소프트웨어") || /red\s*hat|rhel|windows|linux|vmware|ubuntu|운영\s*체제|라이선스|license/i.test(line.text)));
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
          <ul className="reqrows">{sortedReqs.filter((item) => statusOf(item) === "확인 필요").map((item) => {
            const sources = item.sources?.length ? item.sources : item.source ? [item.source] : [];
            const reason = item.key === "manual" ? (item.note && item.note !== "수기 검토" ? item.note : "정량 기준이 없어 자동으로 판정할 수 없습니다")
              : item._new ? "직접 추가한 항목 — 값을 입력해야 판정됩니다"
              : result?.requirements.find((entry) => entry.id === item.id)?.note || item.note || "AI·규칙이 확신하지 못해 사람이 확인해야 합니다";
            return (
              <li key={item.id} className="reqrow s-review review-detail">
                <span className="rq"><ItemIcon k={item.key} />{formatRequirement(item)}</span>
                <span className="rtools-inline">
                  <button type="button" className="lnk small" onClick={() => { setEditingId(item.id); setEditingKey(item.key); setShowReview(false); }}>고치기</button>
                  <button type="button" className="lnk small" onClick={() => remove(item.id)}>삭제</button>
                </span>
                <dl className="rv">
                  <dt>원문 근거</dt><dd>{sources.length ? sources.map((source, index) => <span key={index}>“{source}”</span>) : "—"}</dd>
                  <dt>확인이 필요한 이유</dt><dd>{reason}</dd>
                </dl>
              </li>
            );
          })}</ul>
        </div>
      )}
      <table className="cmp reqtable" aria-label="요구사항">
        <thead><tr><th>항목</th><th>요구 조건</th><th>결과</th><th /></tr></thead>
        <tbody>
          {(group.model_hint || group.suggested_server) && (
            <tr>
              <th scope="row"><span className="cmp-item"><ItemIcon k="model" />서버 모델</span></th>
              <td>{group.model_hint || "미기재"}{group.suggested_server ? "" : " · 카탈로그에 없음"}</td>
              <td className="c"><span className="muted">—</span></td><td />
            </tr>
          )}
          {GROUP_DEFS.map(renderGroup)}
          {sortedReqs.filter((item) => item.key !== "manual" && !GROUP_DEFS.some((def) => def.keys.includes(item.key))).map(renderRow)}
          {softwareLines.map((line) => (
            <tr key={`sw-${line.n}`} className="swrow" title="자동 검증에서 제외 — 공급·설치·라이선스 포함 여부는 별도 확인">
              <th scope="row"><span className="cmp-item"><ItemIcon k="os" />OS·SW</span></th>
              <td>{line.text.replace(/^\W*(?:[가-힣]\.|\(?\d+\)|[-•·]\s*)?\s*/, "")}</td>
              <td className="c"><span className="pill p-sw">별도 확인</span></td><td />
            </tr>
          ))}
          {!requirements.length && <tr><td colSpan={4} className="muted">인식된 요구사항이 없습니다. 직접 추가하거나 원문을 확인하세요.</td></tr>}
        </tbody>
      </table>
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
