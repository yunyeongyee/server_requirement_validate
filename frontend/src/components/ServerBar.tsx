import { useEffect, useRef, useState } from "react";
import type { ProjectSummary, RequirementGroup } from "../types";

interface Props {
  groups: RequirementGroup[];
  summaries: ProjectSummary[];
  activeGroupId: string;
  view: "server" | "all";
  onSelect: (groupId: string) => void;
  onShowAll: () => void;
  onAdd: (copy: boolean) => void;
  onRename: (groupId: string, name: string, quantity: number | null) => void;
  onRemove: (groupId: string) => void;
}

const VERDICT_TONE: Record<string, string> = { "충족": "ok", "미충족": "fail", "구성 불가": "incomp", "확인 필요": "review" };

/** 헤더 아래 서버 탭. 더블클릭 = 이름·수량 바꾸기, ✕ = 삭제, ＋ 서버 = 빈 서버/복제. 색 점은 서버별 결과. */
export default function ServerBar({ groups, summaries, activeGroupId, view, onSelect, onShowAll, onAdd, onRename, onRemove }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);
  const active = groups.find((group) => group.id === activeGroupId);

  return (
    <nav className="servertabs" role="tablist" aria-label="서버">
      {groups.map((group) => {
        const summary = summaries.find((item) => item.id === group.id);
        const verdict = summary?.verdict || "미검증";
        const selected = view === "server" && group.id === activeGroupId;
        if (editing === group.id) return (
          <form key={group.id} className="stab-edit" onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const qty = Number(data.get("qty"));
            onRename(group.id, String(data.get("name") || "").trim() || group.name, qty > 0 ? qty : null);
            setEditing(null);
          }}>
            <input name="name" aria-label="서버 이름" defaultValue={group.name} autoFocus onFocus={(event) => event.target.select()} />
            <span>×</span>
            <input name="qty" aria-label="대수" type="number" min="1" defaultValue={group.quantity || 1} />
            <button type="submit" className="ghost-on-dark">확인</button>
            <button type="button" className="ghost-on-dark" onClick={() => setEditing(null)}>취소</button>
          </form>
        );
        return (
          <span key={group.id} className={`stab-wrap ${selected ? "on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="stab"
              title={`${summary?.model || "-"} · ${verdict} · 더블클릭해서 이름·대수 바꾸기`}
              onClick={() => onSelect(group.id)}
              onDoubleClick={() => setEditing(group.id)}
            >
              <span className={`dot dot-${VERDICT_TONE[verdict] || "none"}`} aria-hidden="true" />
              {group.name}{group.quantity ? <small>×{group.quantity}</small> : null}
            </button>
            {selected && groups.length > 1 && (
              <button type="button" className="stab-x" aria-label={`${group.name} 삭제`} title="이 서버 삭제" onClick={() => onRemove(group.id)}>✕</button>
            )}
          </span>
        );
      })}
      <span className="stab-add" ref={menuRef}>
        <button type="button" className="stab-plus" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>＋ 서버</button>
        {menuOpen && (
          <span className="stab-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { onAdd(false); setMenuOpen(false); }}>
              빈 서버 추가<small>새 탭에 요구사항을 붙여넣기</small>
            </button>
            {active && (
              <button type="button" role="menuitem" onClick={() => { onAdd(true); setMenuOpen(false); }}>
                {active.name} 복제<small>요구사항·구성을 그대로 복사</small>
              </button>
            )}
          </span>
        )}
      </span>
      <button type="button" role="tab" aria-selected={view === "all"} className="stab stab-all" onClick={onShowAll}>전체 결과 ▸</button>
    </nav>
  );
}
