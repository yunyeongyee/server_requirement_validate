import { useEffect, useState } from "react";
import { renderServer } from "../api";
import type { Annot } from "./AnnotationLayer";
import type { PartLabels, Server, ServerConfig, ValidationResult } from "../types";
import type { ProjectSummary } from "../types";

interface Props {
  server: Server | null;
  result: ValidationResult | null;
  error: string;
  loading: boolean;
  projectSummaries: ProjectSummary[];
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
  exportItems: ExportItem[];
}

export interface ExportItem { id: string; name: string; model: string; serverId: string; config: ServerConfig; labels?: PartLabels; annot?: Annot; }

/** 제안서에 붙일 서버 그림(전면·후면) — 라벨(견적 품명 · 수량 EA)과 지시선을 한 번에 켜고 끄고 PNG로 저장 */
function ProposalImages({ items }: { items: ExportItem[] }) {
  const [labelsOn, setLabelsOn] = useState(true);
  const [images, setImages] = useState<Record<string, { front?: string | null; rear?: string | null }>>({});
  const [error, setError] = useState("");
  const key = JSON.stringify([items.map((item) => [item.id, item.serverId, item.config, item.labels, item.annot]), labelsOn]);
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all(items.flatMap((item) => (["front", "rear"] as const).map(async (view) => {
      const response = await renderServer(item.serverId, view, item.config, labelsOn ? item.labels || {} : undefined, labelsOn && item.annot?.labels.length ? { ...item.annot, show: true } : undefined);
      return [item.id, view, response.url] as const;
    }))).then((done) => {
      if (!active) return;
      const next: Record<string, { front?: string | null; rear?: string | null }> = {};
      done.forEach(([id, view, url]) => { next[id] = { ...next[id], [view]: url }; });
      setImages(next);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [key]);
  if (!items.length) return null;
  return (
    <section className="card proposal-images">
      <div className="cardhead">
        <h2>제안서 이미지</h2>
        <button type="button" className={`tog ${labelsOn ? "on" : ""}`} role="switch" aria-checked={labelsOn} onClick={() => setLabelsOn(!labelsOn)}>
          라벨 <span className="sw" aria-hidden="true" /> {labelsOn ? "켜짐" : "꺼짐"}
        </button>
      </div>
      <div className="pad">
        {error && <p className="warn small" role="alert">{error}</p>}
        {items.map((item) => (
          <div key={item.id} className="pi-server">
            <h3>{item.name} <span className="muted small">· {item.model}</span></h3>
            {(["front", "rear"] as const).map((view) => {
              const url = images[item.id]?.[view];
              return (
                <figure key={view}>
                  <figcaption>{view === "front" ? "전면부 구성도" : "후면부 구성도"}
                    {url && <a className="btn small ghost" href={url} download={`${item.name}_${view === "front" ? "전면" : "후면"}${labelsOn ? "" : "_라벨없음"}.png`}>PNG 저장</a>}
                  </figcaption>
                  {url ? <img src={url} alt={`${item.name} ${view === "front" ? "전면" : "후면"}`} /> : <p className="muted small">그림을 만드는 중이거나, 이 모델의 실제 이미지가 없습니다.</p>}
                </figure>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

const STATUS_CLASS: Record<string, string> = {
  "충족": "ok",
  "미충족": "fail",
  "호환 불가": "incomp",
  "확인 필요": "review",
};

function Badge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <em className={`st st-${STATUS_CLASS[status] || "review"}`}>{status}</em>;
}

export default function ResultSection({ server, result, error, loading, projectSummaries, activeGroupId, onSelectGroup, exportItems }: Props) {
  const projectTable = (
    <div className="scroll project-summary">
      <table className="grid">
        <thead><tr><th>요구 서버</th><th>실제 모델</th><th>충족</th><th>미충족</th><th>확인 필요</th><th>결과</th></tr></thead>
        <tbody>{projectSummaries.map((summary) => (
          <tr key={summary.id} className={summary.id === activeGroupId ? "active-project-row" : ""}>
            <td><button className="lnk" onClick={() => onSelectGroup(summary.id)}>{summary.name}</button></td><td>{summary.model}</td><td>{summary.matched}</td><td>{summary.failed}</td><td>{summary.review}</td><td>{summary.verdict === "미검증" || summary.verdict.includes("요구사항 없음") ? <span className="muted">{summary.verdict}</span> : <Badge status={summary.verdict === "충족" ? "충족" : summary.verdict === "구성 불가" ? "호환 불가" : summary.verdict} />}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  if (!result) {
    return (
      <>
        <section id="s6" className="panel">
          <h2>전체 결과</h2>
          <p className="muted">{error || (loading ? "구성을 검증하고 있습니다…" : "서버별 모델과 검증 결과입니다. 서버 이름을 누르면 해당 서버 작업 화면으로 돌아갑니다.")}</p>
          {projectTable}
        </section>
        <ProposalImages items={exportItems} />
      </>
    );
  }

  const usedSlots = result.slots.filter((slot) => slot.component);
  const usedBays = result.bays.map((bay) => ({
    label: `Front Bay ${bay.bay}${bay.role === "boot" ? " (Boot)" : ""}`,
    component: bay.drive,
    status: bay.status,
    issues: bay.issues,
  }));
  const used = [...usedSlots.map((slot) => ({
    label: slot.label,
    component: slot.component || "",
    status: slot.status || "",
    issues: slot.issues,
  })), ...usedBays];
  const rows = [
    ...result.requirements,
    ...used.filter((item) => item.status !== "충족").map((item) => ({
      requirement: `${item.label} 장착 호환성`,
      actual: item.component,
      status: item.status,
      note: item.issues.map((issue) => issue.msg).join(" / "),
    })),
    ...result.general.map((item) => ({
      requirement: "서버 구성 점검",
      actual: "-",
      status: item.status,
      note: item.msg,
    })),
  ];
  const counts = Object.fromEntries(["충족", "미충족", "호환 불가", "확인 필요"].map((status) => [
    status,
    rows.filter((row) => row.status === status).length,
  ]));
  const verdict = counts["호환 불가"] ? "구성 불가 항목 있음"
    : counts["미충족"] ? "요구사항 미충족"
      : counts["확인 필요"] ? "확인 필요 항목 있음" : "전 항목 충족";
  const verdictColor = counts["호환 불가"] ? "incomp"
    : counts["미충족"] ? "fail"
      : counts["확인 필요"] ? "review" : "ok";

  const exportCsv = () => {
    const serverName = server ? `Dell PowerEdge ${server.model}` : "-";
    const header = `서버,"${serverName}"\n요구사항,실제 구성,결과,비고\n`;
    const body = rows.map((row) => [row.requirement, row.actual, row.status, row.note]
      .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
      .join(","))
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff", header, body], { type: "text/csv;charset=utf-8" }));
    link.download = `validation_${server?.id || "server"}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <>
      <section id="s6" className="panel">
        <h2>전체 결과</h2>
        <p className="muted">서버별 모델과 검증 결과입니다. 서버 이름을 누르면 해당 서버 작업 화면으로 돌아갑니다.</p>
        {projectTable}
        <h3 className="active-result-title">{projectSummaries.find((summary) => summary.id === activeGroupId)?.name || "선택 서버"} · 상세 결과</h3>
        <div className="verdict" hidden={!rows.length} style={{ display: "inline-block", background: `var(--${verdictColor})`, color: "#fff", marginBottom: 12 }}>{verdict}</div>
        <div className="tally">
          {["충족", "미충족", "호환 불가", "확인 필요"].map((status) => <span key={status}><b>{counts[status]}</b><Badge status={status} /></span>)}
        </div>
        <div className="scroll">
          <table className="grid result">
            <thead><tr><th>요구사항</th><th>실제 구성</th><th>결과</th><th>비고</th></tr></thead>
            <tbody>{rows.length ? rows.map((row, index) => (
              <tr key={`${row.requirement}-${index}`}>
                <td>{row.requirement}</td><td>{row.actual}</td><td><Badge status={row.status} /></td><td className="src">{row.note}</td>
              </tr>
            )) : <tr><td colSpan={4} className="muted">요구사항이 없습니다.</td></tr>}</tbody>
          </table>
        </div>
        <div className="row">
          <button className="btn" onClick={exportCsv}>결과 CSV 내보내기</button>
          <button className="btn ghost" onClick={() => window.print()}>인쇄 / PDF</button>
        </div>
      </section>
      <ProposalImages items={exportItems} />
    </>
  );
}
