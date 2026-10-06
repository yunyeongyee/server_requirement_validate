import type { ProjectSummary, RequirementGroup } from "../types";

interface Props {
  groups: RequirementGroup[];
  summaries: ProjectSummary[];
  activeGroupId: string;
  view: "server" | "all";
  onSelect: (groupId: string) => void;
  onShowAll: () => void;
}

const VERDICT_TONE: Record<string, string> = { "충족": "ok", "미충족": "fail", "구성 불가": "incomp", "확인 필요": "review" };

/** 헤더 아래 서버 탭 한 줄. 색 점은 서버별 결과, 끝의 '전체 결과'는 프로젝트 결과 화면. */
export default function ServerBar({ groups, summaries, activeGroupId, view, onSelect, onShowAll }: Props) {
  return (
    <nav className="servertabs" role="tablist" aria-label="서버">
      {groups.map((group) => {
        const summary = summaries.find((item) => item.id === group.id);
        const verdict = summary?.verdict || "미검증";
        const selected = view === "server" && group.id === activeGroupId;
        return (
          <button
            type="button"
            role="tab"
            key={group.id}
            aria-selected={selected}
            className="stab"
            title={`${summary?.model || "-"} · ${verdict}`}
            onClick={() => onSelect(group.id)}
          >
            <span className={`dot dot-${VERDICT_TONE[verdict] || "none"}`} aria-hidden="true" />
            {group.name}{group.quantity ? <small>×{group.quantity}</small> : null}
          </button>
        );
      })}
      <button type="button" role="tab" aria-selected={view === "all"} className="stab stab-all" onClick={onShowAll}>전체 결과 ▸</button>
    </nav>
  );
}
