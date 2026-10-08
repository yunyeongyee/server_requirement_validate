import { useState } from "react";
import type { RequirementGroup, Server } from "../types";
import { ConflictList } from "./RequirementSection";


interface Props {
  quote: RequirementGroup | undefined;
  busy: boolean;
  error: string;
  servers: Server[];
  server: Server | null;
  notes: string[] | undefined;
  applying: boolean;
  /** 그림에서 직접 바꿔 견적과 달라진 곳 수 */
  diffCount: number;
  onPaste: (text: string) => void;
  onResolve: (line: number, use: "ai" | "rule") => void;
  onReapply: () => void;
  onClear: () => void;
  onSplit: () => void;
  onKeepOne: () => void;
  onMarkLine: (line: number, mark: "skip" | null) => void;
}

/** 오른쪽 위: 견적 붙여넣기 → 이 서버 그림에 장착. 견적 요약은 한 줄, 상세는 접어 둔다. */
export default function QuotePanel({ quote, busy, error, notes, applying, diffCount, onPaste, onResolve, onReapply, onClear, onSplit, onKeepOne }: Props) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const marks = quote?.line_marks || {};

  if (busy) return (
    <div className="quotebox"><div className="pastebusy" role="status"><span className="spin" aria-hidden="true" />견적을 읽는 중… 실패하면 입력한 내용을 그대로 다시 보여 드립니다.</div></div>
  );
  if (!quote || editing) return (
    <div className="quotebox">
      <b>견적 붙여넣기</b> <span className="muted small">견적 표를 엑셀에서 그대로 긁어 붙여넣으면 아래 서버 그림에 장착됩니다</span>
      <textarea aria-label="견적 붙여넣기" rows={editing ? 8 : 4} value={text} onChange={(event) => setText(event.target.value)} autoFocus={editing}
        placeholder="견적사항을 붙여넣으세요 — 엑셀 견적 표를 그대로 복사해서 Ctrl+V" />
      <div className="row">
        <button type="button" className="btn small" disabled={busy || !text.trim()} onClick={() => { onPaste(text); setEditing(false); }}>{busy ? "읽는 중…" : "견적 적용"}</button>
        {editing && <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>취소</button>}
        {!quote && <span className="muted small">견적 없이 아래 그림에서 직접 구성해도 됩니다</span>}
      </div>
      {error && <p className="warn small" role="alert">{error}</p>}
    </div>
  );

  const lines = quote.lines || [];
  const state = (n: number, status: string) => status === "warn" && marks[n] === "skip" ? "skip" : status;
  const count = (wanted: string) => lines.filter((line) => state(line.n, line.status) === wanted).length;
  const warn = count("warn");
  const replaced = (notes || []).filter((note) => /대체|없음|근사|제한/.test(note)).length;
  const conflicts = quote.ai?.conflicts || [];

  return (
    <div className="quotebox on">
      <div className="quotehead">
        <b>견적</b>
        <span className="muted small">{quote.base_desc || quote.model_hint || "본체 미표기"} · 품목 {count("part")} · 부속품 {count("skip")}
          {replaced ? <> · <span className="q-warn">대체 {replaced}</span></> : null}
          {warn ? <> · <span className="q-warn">확인 필요 {warn}</span></> : null}
          {quote.ai?.used ? <> · AI 정리</> : null}
          {diffCount ? <> · <span className="q-diff">견적 대비 변경 {diffCount}</span></> : null}
        </span>
        <span className="quotehead-act">
          {diffCount > 0 && <button type="button" className="lnk" disabled={applying} onClick={onReapply}>견적대로 복원</button>}
          <button type="button" className="lnk" onClick={() => { setText(quote.text || ""); setEditing(true); }}>다시 붙여넣기</button>
          <button type="button" className="lnk" onClick={() => { if (window.confirm("견적을 지울까요? 그림의 구성은 그대로 둡니다.")) onClear(); }}>지우기</button>
        </span>
      </div>
      {!!quote.split?.length && (
        <div className="splitbar">
          <b>본체가 {quote.split.length}대로 보입니다</b> — {quote.split.map((item) => item.base_desc || item.name).join(" · ")}
          <div className="row">
            <button type="button" className="btn small" onClick={onSplit}>{quote.split.length}개 탭으로 나누기</button>
            <button type="button" className="btn ghost small" onClick={onKeepOne}>첫 번째만 쓰기</button>
          </div>
        </div>
      )}
      {quote.ai?.notice && <p className="warn small" role="status">{quote.ai.notice}</p>}
      <ConflictList conflicts={conflicts} onResolve={onResolve} what="품목" />
    </div>
  );
}
