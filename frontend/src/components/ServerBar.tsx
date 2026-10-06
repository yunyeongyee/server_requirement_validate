import type { ProjectSummary, RequirementGroup } from "../types";

interface Props {
  groups: RequirementGroup[];
  summaries: ProjectSummary[];
  activeGroupId: string;
  onSelect: (groupId: string) => void;
}

const VERDICT_CLASS: Record<string, string> = {
  "충족": "ok", "미충족": "fail", "구성 불가": "incomp", "확인 필요": "review",
};

/** 서버가 여러 대일 때 화면 위에 고정되는 서버 선택 바. 1대면 표시하지 않는다. */
export default function ServerBar({ groups, summaries, activeGroupId, onSelect }: Props) {
  if (groups.length <= 1) return null;
  const totalUnits = groups.reduce((total, group) => total + (group.quantity || 1), 0);
  return (
    <nav className="serverbar" aria-label="서버 선택">
      {groups.map((group) => {
        const summary = summaries.find((item) => item.id === group.id);
        const verdict = summary?.verdict || "미검증";
        const issues = (summary?.failed || 0) + (summary?.review || 0);
        return (
          <button
            type="button"
            key={group.id}
            className={`sb-card ${group.id === activeGroupId ? "on" : ""}`}
            aria-current={group.id === activeGroupId ? "true" : undefined}
            onClick={() => onSelect(group.id)}
          >
            <span className="sb-name">{group.name}{group.quantity ? <small> ×{group.quantity}</small> : null}</span>
            <span className="sb-meta">
              <span>{summary?.model || "-"}</span>
              <em className={`st st-${VERDICT_CLASS[verdict] || "none"}`}>{verdict}{issues && VERDICT_CLASS[verdict] && verdict !== "충족" ? ` ${issues}` : ""}</em>
            </span>
          </button>
        );
      })}
      <span className="sb-total">총 {groups.length}종 · {totalUnits}대</span>
    </nav>
  );
}
