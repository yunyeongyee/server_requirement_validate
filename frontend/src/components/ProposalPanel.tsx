import type { RequirementGroup, Server } from "../types";

interface Props {
  group: RequirementGroup;
  server: Server | null;
  servers: Server[];
  notes: string[] | undefined;
  busy: boolean;
  onApply: () => void;
}

const pct = (value?: number) => (value == null ? "" : `${Math.round(value * 100)}%`);

/** 견적서에서 읽은 서버 1종의 제안 구성 요약 + 판단 근거 + '구성에 적용'. 가격은 표시하지 않는다. */
export default function ProposalPanel({ group, server, servers, notes, busy, onApply }: Props) {
  const p = group.proposed;
  const suggested = servers.find((item) => item.id === group.suggested_server);
  const lowConfidence = (group.confidence ?? 1) < 0.75;
  const unknown = (group.items || []).filter((item) => item.category === "unknown");
  if (!p) return null;
  const line = (label: string, value: string | null | undefined) => value ? <div className="pp-row"><dt>{label}</dt><dd>{value}</dd></div> : null;
  const list = (items: Array<{ desc: string; qty: number }>) => items.map((item) => `${item.desc} × ${item.qty}`).join(" / ");

  return (
    <details className={`proposal ${lowConfidence ? "low" : ""}`} open={!!notes?.length}>
      <summary className="pp-sum">
      <div className="pp-head">
        <h3>견적 구성 <span className="muted">· 대당{group.quantity ? ` × ${group.quantity}대` : ""} · 오른쪽 구성에 자동 적용됨</span></h3>
        <span className="docstat">판단 신뢰도 {pct(group.confidence)}</span>
      </div>
      {!!notes?.length && <span className="pp-warn">⚠ 바뀐 항목 {notes.length}개</span>}
      </summary>
      <dl className="pp-grid">
        {line("본체", group.base_desc || group.model_hint)}
        {line("CPU", p.cpu.count ? `${p.cpu.model || "-"} × ${p.cpu.count}` : null)}
        {line("Memory", p.memory.total_gb ? `${p.memory.total_gb}GB (${p.memory.dimms.map((d) => `${d.size_gb}GB × ${d.qty}`).join(" + ")})` : null)}
        {line("Disk", p.drives.length ? list(p.drives) : null)}
        {line("RAID", p.raid.length ? p.raid.join(" / ") : null)}
        {line("OCP", p.ocp.length ? list(p.ocp) : null)}
        {line("NIC", p.nic.length ? list(p.nic) : null)}
        {line("FC HBA", p.fc.length ? list(p.fc) : null)}
        {line("GPU", p.gpu.length ? list(p.gpu) : null)}
        {line("PSU", p.psu.count ? `${p.psu.watt ?? "-"}W × ${p.psu.count}` : null)}
      </dl>
      <details className="sub">
        <summary>판단 근거 {group.evidence?.length || 0}개{group.notes?.length ? ` · 주의 ${group.notes.length}개` : ""}</summary>
        <ul className="pp-ev">
          {(group.evidence || []).map((text, index) => <li key={`e-${index}`}>{text}</li>)}
          {(group.notes || []).map((text, index) => <li key={`n-${index}`} className="rnote">⚠ {text}</li>)}
          {unknown.map((item, index) => <li key={`u-${index}`} className="rnote">해석 안 됨: {item.code} {item.desc} ({item.where})</li>)}
        </ul>
      </details>
      <div className="row">
        <button className="btn ghost small" disabled={busy || !server} onClick={onApply}>
          {busy ? "적용 중…" : `견적대로 다시 적용 (${server ? server.model : "모델 선택 필요"})`}
        </button>
        {group.model_hint && !suggested && (
          <span className="muted small">견적 모델 '{group.model_hint}' 은 서버 카탈로그에 없습니다 — 선택한 모델로 가장 가까운 부품을 배치합니다.</span>
        )}
        {suggested && server?.id !== suggested.id && <span className="muted small">추천 모델: {suggested.vendor} {suggested.model}</span>}
      </div>
      {!!notes?.length && (
        <ul className="pp-notes">{notes.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
    </details>
  );
}
