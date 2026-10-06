import type { Server, ValidationResult } from "../types";
import type { ProjectSummary } from "../types";

interface Props {
  server: Server | null;
  result: ValidationResult | null;
  error: string;
  loading: boolean;
  projectSummaries: ProjectSummary[];
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
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

export default function ResultSection({ server, result, error, loading, projectSummaries, activeGroupId, onSelectGroup }: Props) {
  const projectTable = (
    <div className="scroll project-summary">
      <table className="grid">
        <thead><tr><th>요구 서버</th><th>실제 모델</th><th>충족</th><th>미충족</th><th>확인 필요</th><th>결과</th></tr></thead>
        <tbody>{projectSummaries.map((summary) => (
          <tr key={summary.id} className={summary.id === activeGroupId ? "active-project-row" : ""}>
            <td><button className="lnk" onClick={() => onSelectGroup(summary.id)}>{summary.name}</button></td><td>{summary.model}</td><td>{summary.matched}</td><td>{summary.failed}</td><td>{summary.review}</td><td>{summary.verdict === "미검증" ? <span className="muted">미검증</span> : <Badge status={summary.verdict === "충족" ? "충족" : summary.verdict === "구성 불가" ? "호환 불가" : summary.verdict} />}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  if (!result) {
    return (
      <>
        <section id="s5" className="panel">
          <h2><span className="n">5</span>호환성 검증</h2>
          {error ? <p className="warn" role="alert">{error}</p> : <p className="muted">{loading ? "구성을 검증하고 있습니다…" : "검증 결과가 없습니다."}</p>}
        </section>
        <section id="s6" className="panel">
          <h2><span className="n">6</span>프로젝트 결과</h2>
          <p className="muted">요구 서버별 실제 모델 선택 및 검증 결과</p>
          {projectTable}
        </section>
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
      <section id="s5" className="panel">
        <h2><span className="n">5</span>호환성 검증</h2>
        {error && <p className="warn" role="alert">{error}</p>}
        {result.general.map((item, index) => <p className="gen" key={`${item.msg}-${index}`}><Badge status={item.status} /> {item.msg}</p>)}
        <p className="muted">
          예상 최대 소비전력(추정) {Math.round(result.summary.power_est_w)}W · 메모리 {result.summary.memory_gb}GB · 사용 가능한 빈 PCIe {result.summary.free_pcie}개
        </p>
        <div className="scroll">
          <table className="grid">
            <thead><tr><th>위치</th><th>부품</th><th>결과</th><th>상세</th></tr></thead>
            <tbody>
              {used.length ? used.map((item, index) => (
                <tr key={`${item.label}-${index}`}>
                  <td>{item.label}</td>
                  <td>{item.component}</td>
                  <td><Badge status={item.status} /></td>
                  <td>{item.issues.map((issue, issueIndex) => (
                    <span key={`${issue.msg}-${issueIndex}`}>{issue.status !== item.status && <><Badge status={issue.status} /> </>}{issue.msg}<br /></span>
                  ))}</td>
                </tr>
              )) : <tr><td colSpan={4} className="muted">장착된 부품이 없습니다. 3단계에서 디스크를 장착하거나 슬롯을 선택하세요.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section id="s6" className="panel">
        <h2><span className="n">6</span>프로젝트 결과</h2>
        <p className="muted">요구 서버별 실제 모델 선택 및 검증 결과</p>
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
    </>
  );
}
