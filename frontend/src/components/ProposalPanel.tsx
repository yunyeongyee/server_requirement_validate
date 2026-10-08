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
export default function ProposalPanel({ group, notes }: Props) {
  const p = group.proposed;
  const lowConfidence = (group.confidence ?? 1) < 0.75;
  if (!p) return null;
  const line = (label: string, value: string | null | undefined) => value ? <div className="pp-row"><dt>{label}</dt><dd>{value}</dd></div> : null;
  // 같은 품목이 여러 줄로 나뉘어 있으면 수량을 합쳐 한 번만
  const list = (items: Array<{ desc: string; qty: number }>) => {
    const merged = new Map<string, number>();
    items.forEach((item) => merged.set(item.desc, (merged.get(item.desc) || 0) + (item.qty || 0)));
    return [...merged].map(([desc, qty]) => `${desc} · ${qty} EA`).join(" / ");
  };

  return (
    <details className={`proposal ${lowConfidence ? "low" : ""}`} open>
      <summary className="pp-sum">
      <div className="pp-head">
        <h3>{group.doc_role === "config" ? "구성도에서 읽은 구성" : "견적 구성"} <span className="muted">· 대당{group.quantity ? ` × ${group.quantity}대` : ""} · 아래 그림에 적용됨</span></h3>
        <span className="docstat">판단 신뢰도 {pct(group.confidence)}</span>
      </div>
      {!!notes?.length && <span className="pp-warn">⚠ 바뀐 항목 {notes.length}개</span>}
      </summary>
      <dl className="pp-grid">
        {line("서버 모델", group.base_desc || group.model_hint)}
        {line("CPU", p.cpu.count ? `${p.cpu.model || "-"} · ${p.cpu.count} EA` : null)}
        {line("Memory", p.memory.total_gb ? `${p.memory.total_gb}GB (${p.memory.dimms.map((d) => `${d.size_gb}GB · ${d.qty} EA`).join(" + ")})` : null)}
        {line("Disk", p.drives.length ? list(p.drives) : null)}
        {line("RAID", p.raid.length ? p.raid.join(" / ") : null)}
        {line("OCP", p.ocp.length ? list(p.ocp) : null)}
        {line("NIC", p.nic.length ? list(p.nic) : null)}
        {line("FC HBA", p.fc.length ? list(p.fc) : null)}
        {line("GPU", p.gpu.length ? list(p.gpu) : null)}
        {line("Riser", p.riser?.length ? list(p.riser) : null)}
        {line("PSU", p.psu.count ? `${p.psu.watt ?? "-"}W · ${p.psu.count} EA` : null)}
      </dl>
    </details>
  );
}
