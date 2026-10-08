import { useState } from "react";
import type { ReactNode } from "react";
import { uploadRequirement } from "../api";
import type { Component, RequirementGroup, Server, ServerConfig, ValidationResult } from "../types";
import { comparisonRequirements, itemLabel, requirementResult } from "../lib/comparison";
import { ItemIcon, StatusBadge } from "./ComparisonUI";

interface Props {
  group: RequirementGroup;
  server: Server | null;
  config: ServerConfig | null;
  components: Component[];
  result: ValidationResult | null;
  validating: boolean;
  appliedAt?: string;
  notes?: string[];
  onApply: (quote: RequirementGroup) => Promise<void>;
  onEdit: (key?: string) => void;
  children: ReactNode;
}
interface Draft { text: string; open: boolean; error: string; candidates: RequirementGroup[]; selected: string; }
const emptyDraft: Draft = { text: "", open: true, error: "", candidates: [], selected: "" };

export default function QuoteSection({ group, server, config, components, result, validating, appliedAt, notes, onApply, onEdit, children }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const draft = drafts[group.id] || { ...emptyDraft, open: !appliedAt };
  const patch = (values: Partial<Draft>) => setDrafts(current => ({ ...current, [group.id]: { ...(current[group.id] || { ...emptyDraft, open: !appliedAt }), ...values } }));
  const apply = async (quote: RequirementGroup) => {
    await onApply(quote);
    patch({ open: false, error: "", candidates: [], selected: "" });
  };
  const submit = async () => {
    if (!server || !config || !draft.text.trim()) return;
    setBusy(true);
    patch({ error: "" });
    try {
      if (draft.candidates.length) {
        const quote = draft.candidates.find(item => item.id === draft.selected);
        if (!quote) throw new Error("적용할 견적 서버를 선택해 주세요.");
        await apply(quote);
      } else {
        // Preserve Excel cells, including empty cells and quoted descriptions.
        const isTable = draft.text.includes("\t");
        const content = isTable ? draft.text.split(/\r?\n/).map(line => line.split("\t").map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n") : draft.text;
        const response = await uploadRequirement(new File([content], isTable ? "견적.csv" : "견적.txt", { type: "text/plain" }), "quote");
        const candidates = (response.groups || []).filter(item => item.doc_role === "quote" && item.proposed && item.items?.some(part => ["cpu", "memory", "drive", "nic", "ocp", "fc", "psu", "gpu"].includes(part.category)));
        if (!candidates.length) throw new Error("견적 구성을 인식하지 못했습니다. 품명·수량 등의 열 제목을 포함해 표 전체를 붙여넣어 주세요. 기존 구성은 유지됩니다.");
        if (candidates.length > 1) patch({ candidates, selected: candidates[0].id });
        else await apply(candidates[0]);
      }
    } catch (error) {
      patch({ error: error instanceof Error ? error.message : String(error), open: true });
    } finally { setBusy(false); }
  };
  const rows = comparisonRequirements(group.requirements);
  const fallback = server && config ? [
    { key: "form_factor", label: "Rack", actual: server.form_factor },
    { key: "cpu_sockets", label: "CPU", actual: `${config.cpu_count} × ${config.cpu_model}` },
    { key: "memory_gb", label: "Memory", actual: `${config.memory.reduce((sum, row) => sum + row.size_gb * row.qty, 0)}GB (${config.memory.map(row => `${row.size_gb}GB × ${row.qty}`).join(" + ")})` },
    { key: "disk_size_gb", label: "Disk", actual: Object.values(config.bays).map(bay => server.drive_options.find(drive => drive.id === bay.drive)?.name || bay.drive).join(" / ") || "미장착" },
    { key: "raid_level", label: "RAID", actual: `Boot ${config.raid.boot || "없음"} / Data ${config.raid.data || "없음"}` },
    { key: "nic_speed_gb", label: "NIC", actual: Object.values(config.slots).map(id => components.find(item => item.id === id)).filter(item => item?.category === "NIC" || item?.category === "OCP NIC").map(item => item!.name).join(" / ") || "미장착" },
    { key: "fc_speed_gb", label: "FC HBA", actual: Object.values(config.slots).map(id => components.find(item => item.id === id)).filter(item => item?.category === "FC HBA").map(item => item!.name).join(" / ") || "미장착" },
    { key: "dual_psu", label: "Dual PSU", actual: `${config.psu_watt}W × ${config.psu_count}` },
  ] : [];
  const tableRows = rows.length ? rows.map(item => {
    const checked = requirementResult(item, result);
    const cpu = itemLabel(item) === "CPU" && config ? `${config.cpu_count} × ${config.cpu_model}` : "";
    return { id: item.id, key: item.key, label: itemLabel(item), actual: item.key === "memory_gb" && config ? `${config.memory.reduce((sum, row) => sum + row.size_gb * row.qty, 0)}GB (${config.memory.map(row => `${row.size_gb}GB × ${row.qty}`).join(" + ")})` : checked?.actual || "검증 대기", cpu, status: checked?.status, note: checked?.note };
  }) : fallback.map(row => ({ ...row, id: row.key, cpu: "", status: undefined, note: "" }));

  return <>
    <section className="panel quote-panel">
      <div className="comparison-heading">
        <h2><ItemIcon label="문서" />견적사항 <small>· {server ? `${server.vendor} ${server.model}` : "모델 선택 필요"}</small></h2>
        <button className="lnk" onClick={() => onEdit()}>구성 수정</button>
      </div>
      {appliedAt && <div className="quote-applied" role="status"><span><b>✓ 견적 적용 완료</b> <time dateTime={appliedAt}>{new Date(appliedAt).toLocaleString("ko-KR")}</time></span><button className="lnk" disabled={busy} onClick={() => patch({ open: !draft.open })}>{draft.open ? "입력창 접기" : "다시 붙여넣기"}</button></div>}
      {draft.open && <div className="quote-input">
        <label htmlFor="quote-paste"><b>견적 붙여넣기</b><span>엑셀 견적표의 열 제목과 품목·수량을 함께 복사해 붙여넣으세요.</span></label>
        <textarea id="quote-paste" rows={4} placeholder="견적 표를 여기에 붙여넣으세요 (Ctrl+V)" value={draft.text} disabled={busy} onChange={event => patch({ text: event.target.value, candidates: [], selected: "", error: "" })}/>
        {!!draft.candidates.length && <label className="quote-target">적용할 견적 서버 <select value={draft.selected} onChange={event => patch({ selected: event.target.value })}>{draft.candidates.map(item => <option key={item.id} value={item.id}>{item.name}{item.model_hint ? ` · ${item.model_hint}` : ""}</option>)}</select></label>}
        <div className="row"><button className="btn small" onClick={() => void submit()} disabled={busy || !server || !config || !draft.text.trim()}>{busy ? "견적 처리 중…" : draft.candidates.length ? "선택한 견적 적용" : "견적 적용"}</button><span className="muted small">적용 후 입력창이 접히고 비교표가 갱신됩니다.</span></div>
      </div>}
      {draft.error && <p className="warn" role="alert">{draft.error}</p>}
      {!!notes?.length && <details className="quote-notes"><summary>견적 반영 시 확인할 사항 {notes.length}개</summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
      <div className="comparison-table-wrap"><table className="comparison-table quote-table">
        <caption className="sr-only">실제 서버 구성과 요구사항 검증 결과</caption>
        <thead><tr><th scope="col">항목</th><th scope="col">실제 구성 ({appliedAt ? "견적 반영" : "현재 설정"})</th><th scope="col">결과</th><th scope="col">비고 / 조치</th></tr></thead>
        <tbody>{tableRows.map(row => {
          const failed = row.status === "미충족" || row.status === "호환 불가";
          return <tr key={row.id} className={failed ? "comparison-failed" : ""}>
            <th scope="row"><span className="comparison-item"><ItemIcon label={row.label}/>{row.label}</span></th>
            <td>{row.cpu && <span>{row.cpu}<br/></span>}{row.actual}</td>
            <td><StatusBadge status={validating ? "검증 중" : rows.length ? row.status : "요구사항 없음"}/></td>
            <td>{failed ? <button className="btn ghost small" onClick={() => onEdit(row.key)}>{row.key.startsWith("fc_") ? "FC HBA 추가" : "구성 수정"}</button> : row.note ? <span className="comparison-note" title={row.note}>{row.note}</span> : <span className="muted">—</span>}</td>
          </tr>;
        })}{!tableRows.length && <tr><td colSpan={4} className="comparison-empty">서버 구성을 불러오는 중입니다.</td></tr>}</tbody>
      </table></div>
    </section>
    {children}
  </>;
}
