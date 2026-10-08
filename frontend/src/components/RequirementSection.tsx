import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { ReactNode } from "react";
import type { ExtractionInfo, Requirement, RequirementGroup, Server, ValidationResult } from "../types";
import ProposalPanel from "./ProposalPanel";
import { comparisonRequirements, itemLabel, requirementCondition, requirementResult } from "../lib/comparison";
import { ItemIcon, StatusBadge } from "./ComparisonUI";

const KEY_DEFS: Record<string, [string, string]> = {
  memory_gb: ["Memory", "GB"],
  cpu_sockets: ["CPU", "Socket"],
  nic_speed_gb: ["NIC Speed", "GbE"],
  nic_ports: ["NIC Port", "Port"],
  fc_speed_gb: ["FC Speed", "Gb"],
  fc_ports: ["FC Port", "Port"],
  ocp_required: ["OCP 3.0", ""],
  raid_level: ["Boot RAID", ""],
  dual_psu: ["Dual PSU", ""],
  psu_watt: ["PSU Capacity", "W"],
  free_pcie: ["Free PCIe Slot", "EA"],
  gpu_count: ["GPU", "EA"],
  manual: ["수기 검토", ""],
};
const BOOLEAN_KEYS = new Set(["ocp_required", "dual_psu"]);
interface Props {
  result: ValidationResult | null;
  validating: boolean;
  groups: RequirementGroup[];
  activeGroupId: string;
  documentName: string;
  documentText: string;
  extractionInfo: ExtractionInfo | null;
  busy: boolean;
  error: string;
  onUpload: (file: File) => void;
  onSelectGroup: (groupId: string) => void;
  onChange: (groupId: string, requirements: Requirement[]) => void;
  onReExtract: (text: string) => void;
  servers: Server[];
  activeServer: Server | null;
  proposalNotes: Record<string, string[]>;
  applyingGroupId: string | null;
  onApplyProposal: (groupId: string) => void;
}

function formatRequirement(requirement: Requirement): string {
  const [label, unit] = KEY_DEFS[requirement.key] || [requirement.label, requirement.unit || ""];
  if (requirement.key === "manual") return requirement.label && requirement.label !== "수기 검토" ? requirement.label : requirement.source || "수기 검토";
  if (BOOLEAN_KEYS.has(requirement.key) || requirement.value === true) return `${label} 필요`;
  if (requirement.value === "" || requirement.value == null) return label;
  const value = typeof requirement.value === "number" ? +requirement.value.toFixed(2) : requirement.value;
  const operator = ({ ">=": "≥", "<=": "≤", "=": "", "?": "" } as Record<string, string>)[requirement.op] ?? requirement.op;
  return `${label} ${operator ? `${operator} ` : ""}${value}${unit ? ` ${unit}` : ""}`;
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
  result,
  validating,
  groups,
  activeGroupId,
  documentName,
  documentText,
  extractionInfo,
  busy,
  error,
  onUpload,
  onSelectGroup,
  onChange,
  onReExtract,
  servers,
  activeServer,
  proposalNotes,
  applyingGroupId,
  onApplyProposal,
}: Props) {
  const [hidePassed, setHidePassed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [editedDocumentText, setEditedDocumentText] = useState(documentText);
  const [showDocument, setShowDocument] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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
    setEditingKey("memory_gb");
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

  const automatic = requirements.filter((item) => item.status !== "review" && item.key !== "manual");
  const rows = comparisonRequirements(requirements);
  const passed = rows.filter(item => requirementResult(item, result)?.status === "충족").length;
  const failed = rows.filter(item => ["미충족", "호환 불가"].includes(requirementResult(item, result)?.status || "")).length;
  const review = requirements.filter((item) => item.status === "review" || item.key === "manual");
  const sourceHighlights = [
    ...requirements.map((item) => item.source),
    ...spec.flatMap((group) => group.items.map((item) => item.source)),
  ];

  return (
    <section id="s1" className="panel requirement-panel">
      <div className="comparison-heading">
        <h2><ItemIcon label="문서" />요구사항 <small>· {activeGroup?.name || "서버 1"}</small></h2>
        <div className="comparison-counts" aria-live="polite">
          {validating ? <span className="comparison-status pending">검증 중…</span> : <><span className="comparison-status ok">충족 {passed}</span><span className="comparison-status fail">미충족 {failed}</span><span className="comparison-status review">확인 {review.length + rows.filter(item => requirementResult(item, result)?.status === "확인 필요").length}</span></>}
        </div>
      </div>
      {!documentName && (
        <label
          className={`drop ${dragging ? "over" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.xlsx,.xlsm,.txt,.csv,.json"
            onChange={chooseFile}
            disabled={busy}
          />
          <strong>{busy ? "요구사항 분석 중…" : "요구사항 문서를 끌어다 놓거나 클릭"}</strong>
          <span>PDF · DOCX · XLSX · TXT · CSV · JSON</span>
        </label>
      )}
      {error && <p className="warn" role="alert">{error}</p>}
      {documentName && (
        <div className="docbar">
          <span className="docname">{documentName}</span>
          <span className="docstat">{groups.length}개 서버</span>
          <span className="docstat">{groups.reduce((count, group) => count + group.requirements.length, 0)}개 요구사항</span>
          <span className="docstat review-stat">{groups.reduce((count, group) => count + group.requirements.filter((item) => item.status === "review").length, 0)}개 확인 필요</span>
          {extractionInfo?.mode === "ai" && <span className="docstat">AI 분석 · {extractionInfo.effort || "low"}</span>}
          <button className="btn ghost small" onClick={() => { setEditedDocumentText(documentText); setShowDocument(true); }}>원문 보기</button>
          <button className="btn ghost small" onClick={() => fileInput.current?.click()}>다른 문서</button>
          <input ref={fileInput} type="file" accept=".pdf,.docx,.xlsx,.xlsm,.txt,.csv,.json" hidden onChange={chooseFile} />
        </div>
      )}
      {extractionInfo?.notice && <p className="warn" role="status">{extractionInfo.notice}</p>}
      {documentName && (
        <>
          {groups.length > 1 && (
            <nav className="server-tabs" aria-label="요구 서버 선택">
              {groups.map((group) => (
                <button type="button" key={group.id} className={group.id === activeGroup?.id ? "on" : ""} onClick={() => onSelectGroup(group.id)}>
                  <span>{group.name}{group.quantity ? ` · ${group.quantity}대` : ""}</span><small>{group.requirements.length}개</small>
                </button>
              ))}
            </nav>
          )}
          {activeGroup?.doc_role === "quote" ? (
            <ProposalPanel
              group={activeGroup}
              server={activeServer}
              servers={servers}
              notes={proposalNotes[activeGroup.id]}
              busy={applyingGroupId === activeGroup.id}
              onApply={() => onApplyProposal(activeGroup.id)}
            />
          ) : null}
        </>
      )}
      <div className="comparison-table-wrap">
        <table className="comparison-table requirements-table">
          <caption className="sr-only">요구사항과 실제 구성 검증 결과</caption>
          <thead><tr><th scope="col">항목</th><th scope="col">요구사항</th><th scope="col">결과</th></tr></thead>
          <tbody>{rows.filter(item => !hidePassed || requirementResult(item, result)?.status !== "충족").map(item => {
            const checked = requirementResult(item, result);
            return <tr key={item.id} className={checked && ["미충족", "호환 불가"].includes(checked.status) ? "comparison-failed" : ""}>
              <th scope="row"><span className="comparison-item"><ItemIcon label={itemLabel(item)} />{itemLabel(item)}</span></th>
              <td><strong>{requirementCondition(item)}</strong><small>실제 {checked?.actual || "검증 대기"}</small></td>
              <td><StatusBadge status={validating ? "검증 중" : checked?.status} /></td>
            </tr>;
          })}
          {!rows.length && <tr><td colSpan={3} className="comparison-empty">문서를 올리면 요구사항이 항목별로 표시됩니다.</td></tr>}
          {!!rows.length && hidePassed && passed === rows.length && <tr><td colSpan={3} className="comparison-empty">모든 요구사항을 충족했습니다.</td></tr>}
          </tbody>
        </table>
      </div>
        {!!review.length && (
          <div className="manual-review">
            <h3>⚠ 수기 검토 <span className="comparison-status review">확인 {review.length}</span></h3>
            <ul className="reqs">{review.map((item) => (
              <li className={`req isreview ${editingId === item.id ? "editing" : ""}`} key={item.id}>
                {editingId === item.id ? (
                  <form onSubmit={(event) => { event.preventDefault(); saveEdit(item, event.currentTarget); }}>
                    <select name="key" value={editingKey} onChange={(event) => setEditingKey(event.target.value)}>
                      {!KEY_DEFS[item.key] && <option value={item.key}>{item.label}</option>}
                    {Object.entries(KEY_DEFS).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                    <select name="op" defaultValue={item.op}><option>&gt;=</option><option>=</option><option>&lt;=</option></select>
                    <input name="value" defaultValue={typeof item.value === "boolean" ? (item.value ? "필요" : "") : item.value ?? ""} disabled={BOOLEAN_KEYS.has(editingKey)} />
                    <label className="chk"><input type="checkbox" name="review" defaultChecked /> 확인 필요</label>
                    <button className="btn small" type="submit">저장</button>
                    <button className="btn ghost small" type="button" onClick={() => { setEditingId(null); setEditingKey(""); }}>취소</button>
                  </form>
                ) : (
                  <>
                    <span className="rtext">{formatRequirement(item)}</span>
                    {item.note && <span className="rnote">{item.note}</span>}
                    {(item.sources?.length || item.source) && <details className="source-detail req-source"><summary>근거 보기</summary>{(item.sources?.length ? item.sources : [item.source]).map((source, index) => <p key={`${item.id}-source-${index}`}>{source}</p>)}{item.note && <p className="rnote">{item.note}</p>}</details>}
                    <span className="ract">
                      <button className="ico" aria-label="편집" onClick={() => beginEdit(item)}>✎</button>
                      <button className="ico" aria-label="삭제" onClick={() => removeRequirement(item.id)}>✕</button>
                    </span>
                  </>
                )}
              </li>
            ))}</ul>
          </div>
        )}
      <div className="comparison-tools">
        <button className="lnk" onClick={() => setHidePassed(!hidePassed)} aria-pressed={hidePassed}>{hidePassed ? "충족 항목 펼치기" : "충족 항목 접기"} ({passed}개)</button>
        <button className="lnk" onClick={addRequirement}>+ 직접 추가</button>
      </div>
      <div>
        <div className="reqhead">
          <h3>요구사항 <span className="docstat">{automatic.length} 자동</span>{review.length > 0 && <span className="docstat review-stat">{review.length} 확인 필요</span>}</h3>
          <button className="btn ghost small" onClick={addRequirement}>+ 요구사항 추가</button>
        </div>
        <details className="requirement-details" open={editingId !== null || undefined}>
          <summary>요구사항 수정 · {automatic.length}개</summary>
          <ul className="reqs">
          {automatic.length ? automatic.map((item) => (
            <li className={`req ${editingId === item.id ? "editing" : ""}`} key={item.id}>
              {editingId === item.id ? (
                <form onSubmit={(event) => { event.preventDefault(); saveEdit(item, event.currentTarget); }}>
                  <select name="key" value={editingKey} onChange={(event) => setEditingKey(event.target.value)}>
                    {!KEY_DEFS[item.key] && <option value={item.key}>{item.label}</option>}
                    {Object.entries(KEY_DEFS).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                  <select name="op" defaultValue={item.op}>
                    {[">=", "=", "<="].map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                  </select>
                  <input name="value" defaultValue={typeof item.value === "boolean" ? (item.value ? "필요" : "") : item.value ?? ""} disabled={BOOLEAN_KEYS.has(editingKey)} placeholder="값" />
                  <label className="chk"><input type="checkbox" name="review" defaultChecked={item.status === "review" || item.key === "manual"} /> 확인 필요</label>
                  <button className="btn small" type="submit">저장</button>
                  <button className="btn ghost small" type="button" onClick={() => {
                    if (item._new) removeRequirement(item.id);
                    setEditingId(null);
                    setEditingKey("");
                  }}>취소</button>
                </form>
              ) : (
                <>
                  <span className="rtext">{formatRequirement(item)}</span>
                  {item.status === "review" && item.note && <span className="rnote">{item.note}</span>}
                  {(item.sources?.length || item.source) && <details className="source-detail req-source"><summary>근거 보기</summary>{(item.sources?.length ? item.sources : [item.source]).map((source, index) => <p key={`${item.id}-source-${index}`}>{source}</p>)}{item.note && <p className="rnote">{item.note}</p>}</details>}
                  <span className="ract">
                    <button className="ico" aria-label="편집" onClick={() => beginEdit(item)}>✎</button>
                    <button className="ico" aria-label="삭제" onClick={() => removeRequirement(item.id)}>✕</button>
                  </span>
                </>
              )}
            </li>
          )) : <li className="empty muted">{documentName ? "자동으로 인식된 요구사항이 없습니다. 직접 추가할 수 있습니다." : "문서를 올리면 요구사항이 여기에 정리됩니다."}</li>}
          </ul>
        </details>

      </div>
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
