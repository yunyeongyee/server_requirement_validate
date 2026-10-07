import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { ReactNode } from "react";
import type { ExtractionInfo, Requirement, RequirementGroup, Server, ValidationResult } from "../types";
import type { FocusRequest } from "./ConfigSection";
import ProposalPanel from "./ProposalPanel";

const KEY_DEFS: Record<string, [string, string]> = {
  memory_gb: ["Memory", "GB"],
  cpu_sockets: ["CPU", "Socket"],
  nic_speed_gb: ["NIC Speed", "GbE"],
  nic_ports: ["NIC Port", "Port"],
  fc_speed_gb: ["FC Speed", "Gb"],
  fc_ports: ["FC Port", "Port"],
  ocp_required: ["OCP 3.0", ""],
  raid_level: ["RAID", ""],
  dual_psu: ["Dual PSU", ""],
  psu_watt: ["PSU Capacity", "W"],
  free_pcie: ["Free PCIe Slot", "EA"],
  gpu_count: ["GPU", "EA"],
  manual: ["수기 검토", ""],
};
const BOOLEAN_KEYS = new Set(["ocp_required", "dual_psu"]);
const SPEC_KIND_LABELS: Record<string, string> = {
  configuration: "실제 구성",
  quote: "견적 품목",
  common_option: "공통 옵션",
};

interface Props {
  groups: RequirementGroup[];
  activeGroupId: string;
  documentName: string;
  documentText: string;
  extractionInfo: ExtractionInfo | null;
  busy: boolean;
  error: string;
  onUpload: (file: File) => void;
  onChange: (groupId: string, requirements: Requirement[]) => void;
  onReExtract: (text: string) => void;
  servers: Server[];
  activeServer: Server | null;
  proposalNotes: Record<string, string[]>;
  applyingGroupId: string | null;
  onApplyProposal: (groupId: string) => void;
  result: ValidationResult | null;
  onFocus: (request: Omit<FocusRequest, "n">) => void;
  /** 헤더의 '원문' / '다른 문서' 버튼이 바꾸는 값 */
  showDocumentSignal: number;
  pickFileSignal: number;
}

const STATUS_CLASS: Record<string, string> = { "충족": "ok", "미충족": "fail", "호환 불가": "incomp", "확인 필요": "review" };
/** 미충족 요구사항을 고칠 곳: 슬롯 부품 또는 사양 */
function fixFor(key: string): { label: string; request: Omit<FocusRequest, "n"> } | null {
  if (key.startsWith("fc_")) return { label: "FC HBA 추가", request: { kind: "slot", part: "fc" } };
  if (key.startsWith("nic_") || key === "ocp_required") return { label: "NIC 추가", request: { kind: "slot", part: "nic" } };
  if (key === "gpu_count") return { label: "GPU 추가", request: { kind: "slot", part: "gpu" } };
  if (["memory_gb", "cpu_sockets", "dual_psu", "psu_watt", "raid_level"].includes(key)) return { label: "사양 수정", request: { kind: "spec" } };
  return null;
}

function formatRequirement(requirement: Requirement): string {
  const [label, unit] = KEY_DEFS[requirement.key] || [requirement.label, requirement.unit || ""];
  if (requirement.key === "manual") return requirement.label || "수기 검토";
  if (BOOLEAN_KEYS.has(requirement.key) || requirement.value === true) return `${label} 필요`;
  if (requirement.value === "" || requirement.value == null) return label;
  const value = typeof requirement.value === "number" ? +requirement.value.toFixed(2) : requirement.value;
  const operator = ({ ">=": "≥", "<=": "≤", "=": "", "?": "" } as Record<string, string>)[requirement.op] ?? requirement.op;
  return `${label} ${operator ? `${operator} ` : ""}${value}${unit ? ` ${unit}` : ""}`;
}

function specKindLabel(item: { kind?: string; confidence?: number }): string | null {
  if (!item.kind) return null;
  const label = SPEC_KIND_LABELS[item.kind] || item.kind;
  return item.confidence != null && item.confidence < 0.75 ? `확인 필요 · ${label}` : label;
}

function renderHighlightedSource(text: string, sources: string[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const source of new Set(sources.filter(Boolean))) {
    let start = text.indexOf(source);
    while (start !== -1) {
      ranges.push({ start, end: start + source.length });
      start = text.indexOf(source, start + source.length);
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged = ranges.reduce<Array<{ start: number; end: number }>>((result, current) => {
    const last = result[result.length - 1];
    if (!last || current.start >= last.end) result.push({ ...current });
    else last.end = Math.max(last.end, current.end);
    return result;
  }, []);
  const chunks: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(({ start, end }, index) => {
    if (cursor < start) chunks.push(text.slice(cursor, start));
    chunks.push(<mark key={`source-${index}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}

export default function RequirementSection({
  groups,
  activeGroupId,
  documentName,
  documentText,
  extractionInfo,
  busy,
  error,
  onUpload,
  onChange,
  onReExtract,
  servers,
  activeServer,
  proposalNotes,
  applyingGroupId,
  onApplyProposal,
  result,
  onFocus,
  showDocumentSignal,
  pickFileSignal,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [editedDocumentText, setEditedDocumentText] = useState(documentText);
  const [showDocument, setShowDocument] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showDocumentSignal) { setEditedDocumentText(documentText); setShowDocument(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDocumentSignal]);
  useEffect(() => {
    if (pickFileSignal) fileInput.current?.click();
  }, [pickFileSignal]);
  const activeGroup = groups.find((group) => group.id === activeGroupId) || groups[0];
  const requirements = activeGroup?.requirements || [];
  const spec = activeGroup?.spec || [];

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onUpload(file);
  };

  const updateRequirement = (id: string, update: Partial<Requirement>) => {
    onChange(activeGroup.id, requirements.map((item) => item.id === id ? { ...item, ...update } : item));
  };

  const addRequirement = () => {
    const id = crypto.randomUUID();
    onChange(activeGroup.id, [...requirements, {
      id,
      key: "memory_gb",
      label: "Memory",
      unit: "GB",
      op: ">=",
      value: "",
      source: "(직접 추가)",
      status: "auto",
      _new: true,
    }]);
    setEditingId(id);
  };

  const removeRequirement = (id: string) => {
    onChange(activeGroup.id, requirements.filter((item) => item.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const saveEdit = (item: Requirement, form: HTMLFormElement) => {
    const values = new FormData(form);
    const key = String(values.get("key"));
    const rawValue = String(values.get("value") ?? "").trim();
    const [label, unit] = KEY_DEFS[key] || [item.label, item.unit || ""];
    const value: Requirement["value"] = BOOLEAN_KEYS.has(key)
      ? true
      : rawValue !== "" && Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue;
    updateRequirement(item.id, {
      key,
      label,
      unit,
      op: String(values.get("op")),
      value,
      status: values.has("review") || key === "manual" ? "review" : "auto",
      _new: false,
    });
    setEditingId(null);
    setEditingKey("");
  };
  const beginEdit = (item: Requirement) => {
    setEditingId(item.id);
    setEditingKey(item.key);
  };

  const sourceHighlights = [
    ...requirements.map((item) => item.source),
    ...spec.flatMap((group) => group.items.map((item) => item.source)),
  ];

  const renderEdit = (item: Requirement) => (
    <form className="reqedit" onSubmit={(event) => { event.preventDefault(); saveEdit(item, event.currentTarget); }}>
      <select name="key" value={editingKey} onChange={(event) => setEditingKey(event.target.value)} aria-label="항목">
        {Object.entries(KEY_DEFS).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select name="op" defaultValue={item.op} aria-label="조건">
        {[">=", "=", "<="].map((operator) => <option key={operator} value={operator}>{operator}</option>)}
      </select>
      <input name="value" aria-label="값" defaultValue={typeof item.value === "boolean" ? (item.value ? "필요" : "") : item.value ?? ""} disabled={BOOLEAN_KEYS.has(editingKey)} placeholder="값" />
      <label className="chk"><input type="checkbox" name="review" defaultChecked={item.status === "review"} /> 확인 필요</label>
      <button className="btn small" type="submit">저장</button>
      <button className="btn ghost small" type="button" onClick={() => {
        if (item._new) removeRequirement(item.id);
        setEditingId(null);
        setEditingKey("");
      }}>취소</button>
    </form>
  );
  const rows = requirements.map((item) => {
    const checked = result?.requirements.find((row) => (row as { id?: string }).id === item.id);
    const status = item.status === "review" || item._new ? "확인 필요" : checked?.status || "확인 필요";
    return { item, status, actual: checked?.actual || "-", note: item.status === "review" ? item.note || "" : checked?.note || "" };
  });
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const specCount = spec.reduce((total, group) => total + group.items.length, 0);

  if (!documentName) return (
    <section id="s1" className="card start">
      <label
        className={`drop ${dragging ? "over" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input ref={fileInput} type="file" accept=".pdf,.docx,.xlsx,.xlsm,.txt,.csv,.json" onChange={chooseFile} disabled={busy} />
        <strong>{busy ? "문서 분석 중…" : "요구사항 문서나 견적서를 끌어다 놓거나 클릭"}</strong>
        <span>PDF · DOCX · XLSX · TXT · CSV · JSON — 서버 구분, 모델 선택, 견적 구성 적용까지 자동으로 합니다</span>
      </label>
      {error && <p className="warn" role="alert">{error}</p>}
    </section>
  );

  return (
    <section id="s1" className="card reqcard">
      <input ref={fileInput} type="file" accept=".pdf,.docx,.xlsx,.xlsm,.txt,.csv,.json" hidden onChange={chooseFile} />
      <div className="cardhead">
        <h2>요구사항 <span className="muted">· {activeGroup?.name || "서버"}{activeGroup?.quantity ? ` ×${activeGroup.quantity}` : ""}</span></h2>
        <div className="counts">
          {count("충족") > 0 && <span className="pill p-ok">충족 {count("충족")}</span>}
          {count("확인 필요") > 0 && <span className="pill p-review">확인 {count("확인 필요")}</span>}
          {count("미충족") + count("호환 불가") > 0 && <span className="pill p-fail">미충족 {count("미충족") + count("호환 불가")}</span>}
        </div>
      </div>
      {error && <p className="warn pad" role="alert">{error}</p>}
      {extractionInfo?.notice && <p className="warn pad" role="status">{extractionInfo.notice}</p>}
      {activeGroup?.proposed && (activeGroup.doc_role === "quote" || activeGroup.doc_role === "config") && (
        <ProposalPanel
          group={activeGroup}
          server={activeServer}
          servers={servers}
          notes={proposalNotes[activeGroup.id]}
          busy={applyingGroupId === activeGroup.id}
          onApply={() => onApplyProposal(activeGroup.id)}
        />
      )}
      <ul className="reqrows">
        {rows.map(({ item, status, actual, note }) => {
          const tone = STATUS_CLASS[status] || "review";
          const fix = status !== "충족" ? fixFor(item.key) : null;
          const sources = item.sources?.length ? item.sources : item.source ? [item.source] : [];
          return (
            <li key={item.id} className={`reqrow s-${tone}`} tabIndex={editingId === item.id ? undefined : 0}>
              {editingId === item.id ? renderEdit(item) : (
                <>
                  <span className="rq">{formatRequirement(item)}</span>
                  <span className="ra">실제: <b>{actual}</b>{note ? ` · ${note}` : ""}</span>
                  <span className="rs">
                    <span className={`pill p-${tone}`}>{status}</span>
                    {fix && <button type="button" className="fix" onClick={() => onFocus(fix.request)}>{fix.label}</button>}
                  </span>
                  <span className="rtools">
                    <button className="ico" aria-label="편집" onClick={() => beginEdit(item)}>✎</button>
                    <button className="ico" aria-label="삭제" onClick={() => removeRequirement(item.id)}>✕</button>
                  </span>
                  {!!sources.length && <span className="rsrc" role="tooltip"><small>원문</small>{sources.map((source, index) => <span key={index}>“{source}”</span>)}</span>}
                </>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="reqempty muted">{activeGroup?.proposed ? `${activeGroup.doc_role === "config" ? "구성도" : "견적서"}에는 검증할 요구사항이 없습니다. 위 구성이 오른쪽에 적용되어 있습니다. 고객 요구사항이 있으면 추가하세요.` : "자동으로 인식된 요구사항이 없습니다. 직접 추가하거나 원문을 확인하세요."}</li>}
      </ul>
      <button className="addreq" onClick={addRequirement}>+ 요구사항 추가</button>
      {specCount > 0 && (
        <details className="fold pad">
          <summary>문서에서 추출한 사양 {specCount}개</summary>
          <div className="specgrid">
            {spec.flatMap((group) => group.items.map((item, index) => (
              <div className="specitem" key={`${group.category}-${index}`} title={item.source}>
                <span className="specitem-label">{group.category}</span>
                <strong>{specKindLabel(item) && <span className="spec-kind">{specKindLabel(item)}</span>} {item.value}</strong>
              </div>
            )))}
          </div>
        </details>
      )}
      {!!activeGroup?.evidence?.length && !activeGroup.proposed && (
        <p className={`muted small pad group-evidence ${(activeGroup.confidence ?? 1) < 0.75 ? "low" : ""}`}>
          서버 구분 근거: {activeGroup.evidence.join(" · ")}{activeGroup.notes?.length ? ` · ⚠ ${activeGroup.notes.join(" · ")}` : ""}
        </p>
      )}
      {showDocument && (
        <dialog open className="document-dialog">
          <div className="dlghead">
            <h3>원문 — {documentName}</h3>
            <button className="x" aria-label="닫기" onClick={() => { setShowDocument(false); setEditingText(false); }}>✕</button>
          </div>
          <p className="muted">노란 표시는 요구사항·사양으로 추출된 문장입니다.</p>
          {editingText
            ? <textarea rows={16} value={editedDocumentText} onChange={(event) => setEditedDocumentText(event.target.value)} />
            : <div className="doctext">{renderHighlightedSource(documentText, sourceHighlights)}</div>}
          <div className="row">
            <button className="btn ghost small" onClick={() => setEditingText(!editingText)}>{editingText ? "편집 완료" : "본문 편집"}</button>
            {editingText && <button className="btn small" onClick={() => { onReExtract(editedDocumentText); setEditingText(false); }}>이 본문으로 다시 추출</button>}
          </div>
        </dialog>
      )}
    </section>
  );
}
