import { pasteTable } from "../lib/clipboardTable";
import { useState } from "react";
import type { RequirementGroup, Server } from "../types";
import { ConflictList } from "./RequirementSection";
import type { Unresolved } from "../types";


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
  /** 정확히 같은 부품이 없어 장착하지 않은 항목 / 대체 배치 승인 */
  unresolved?: Unresolved[];
  /** 서버 모델이 정해지지 않아 견적을 그림에 장착하지 못한 상태 */
  needModel?: boolean;
  onApprove?: (desc: string) => void;
  /** 수량 확인: 대당/합계 선택 또는 품목별 수량 입력 */
  onQuantity?: (change: { scope?: "per_server" | "group_total"; qty?: Record<number, number> }) => void;
}

/** 오른쪽 위: 견적 붙여넣기 → 이 서버 그림에 장착. 견적 요약은 한 줄, 상세는 접어 둔다. */
export default function QuotePanel({ quote, busy, error, notes, applying, diffCount, onPaste, onResolve, onReapply, onClear, onSplit, onKeepOne, unresolved = [], needModel = false, onApprove, onQuantity }: Props) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const marks = quote?.line_marks || {};
  const [typed, setTyped] = useState<Record<number, string>>({});

  if (busy) return (
    <div className="quotebox"><div className="pastebusy" role="status"><span className="spin" aria-hidden="true" />견적을 읽는 중… 실패하면 입력한 내용을 그대로 다시 보여 드립니다.</div></div>
  );
  if (!quote || editing) return (
    <div className="quotebox">
      <b>견적 붙여넣기</b> <span className="muted small">견적 표를 엑셀에서 그대로 긁어 붙여넣으면 아래 서버 그림에 장착됩니다</span>
      <textarea aria-label="견적 붙여넣기" rows={editing ? 8 : 4} value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => pasteTable(event, setText)} autoFocus={editing}
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
      {needModel && <p className="warn small pad" role="status">서버 모델이 정해지지 않아 견적을 그림에 장착하지 않았습니다 — 위 [구성 편집]에서 모델을 선택하면 견적대로 장착합니다.</p>}
      <ConflictList conflicts={conflicts} onResolve={onResolve} what="품목" />
      {(() => {
        // 정제 결과: 정상 행은 아무 표시 없이, 문제가 있는 칸에만 ⚠ — 수량이 불확실하면 그 칸에서 바로 고친다
        const all = quote.items || [];
        const serverQty = quote.server_quantity || 1;
        const clean = (desc: string) => desc.replace(/^\s*[가-힣]\.\s*/, "").replace(/^[A-Za-z ]{2,10}[:：]\s*/, "");
        const rows = all.map((item, index) => ({ item, index })).filter(({ item }) => !["accessory", "license"].includes(item.category));
        const have = new Set(rows.map(({ item }) => item.category));
        const absent = ["cpu", "memory", "drive", "psu"].filter((cat) => !have.has(cat));
        const KO: Record<string, string> = { cpu: "CPU", memory: "Memory", drive: "Disk", psu: "PSU" };
        const unknownScope = rows.some(({ item }) => item.quantity_scope === "unknown");
        if (!rows.length) return null;
        return (
          <table className="cmp qtable" aria-label="견적 정제 결과">
            <thead><tr><th>항목</th><th>견적 구성</th><th>수량</th></tr></thead>
            <tbody>
              {rows.map(({ item, index }) => {
                const isBase = item.category === "base";
                const shown = clean(item.desc);
                const flagged = !isBase && (item.qty == null || item.where.includes("⚠"));
                const scopeOpen = !isBase && item.quantity_scope === "unknown" && item.qty != null;
                let qty: React.ReactNode = isBase ? (item.qty != null ? `${item.qty}대` : `${serverQty}대`) : item.qty != null ? `${item.qty}${scopeOpen ? "개" : "/대"}` : null;
                if (flagged && item.qty == null) qty = (
                  <span className="qwarn">⚠ <input type="number" min={1} className="qtyin" aria-label={`${shown} 수량`} value={typed[index] ?? ""} onChange={(event) => setTyped({ ...typed, [index]: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && Number(typed[index]) >= 1) onQuantity?.({ qty: { [index]: Number(typed[index]) } }); }} />
                    <button type="button" className="lnk small" disabled={!(Number(typed[index]) >= 1)} onClick={() => onQuantity?.({ qty: { [index]: Number(typed[index]) } })}>입력</button></span>);
                else if (flagged) qty = <span className="qwarn" title={item.where}>⚠ {qty}</span>;
                return (
                  <tr key={index} title={`원문: ${item.where}`}>
                    <th scope="row">{item.category_ko === "OCP NIC" ? "OCP" : item.category_ko}</th>
                    <td>{isBase ? shown.replace(/^PY\s+/i, "PRIMERGY ") : shown}</td>
                    <td className="q">{qty}</td>
                  </tr>
                );
              })}
              {absent.map((cat) => (
                <tr key={`absent-${cat}`} className="absent"><th scope="row">{KO[cat]}</th><td className="empty">문서에 없음</td><td className="q">—</td></tr>
              ))}
              {unknownScope && (
                <tr className="qscope"><td colSpan={3}>
                  <span className="qwarn">⚠</span> 서버 {serverQty}대 견적 — 부품 수량이 <button type="button" className="lnk" onClick={() => onQuantity?.({ scope: "per_server" })}>대당 그대로</button> · <button type="button" className="lnk" onClick={() => onQuantity?.({ scope: "group_total" })}>합계(대당 ÷{serverQty})</button>
                </td></tr>
              )}
            </tbody>
          </table>
        );
      })()}
      {unresolved.length > 0 && (
        <div className="warnlist unres" role="region" aria-label="장착하지 않은 견적 항목">
          <b>⚠ 견적과 정확히 같은 부품이 없어 장착하지 않은 항목 {unresolved.length}개</b> <span className="muted small">— 다른 사양을 임의로 꽂지 않습니다. 확인 후 승인하면 가장 가까운 부품으로 배치합니다.</span>
          {unresolved.map((item) => (
            <div key={item.desc} className="cf">
              <div className="cf-text" title={item.desc}>{item.desc}{item.qty ? ` · ${item.qty} EA` : ""}</div>
              <div className="cf-why">{item.reason}{item.nearest ? ` — 가장 가까운 부품: ${item.nearest}` : " — 대체할 부품도 없음"}</div>
              {item.nearest && onApprove && <button type="button" className="btn ghost small" onClick={() => onApprove(item.desc)}>대체 배치 승인 · {item.nearest}</button>}
            </div>
          ))}
        </div>
      )}
      {!!notes?.length && (
        <details className="quote-notes">
          <summary className="muted small">견적을 구성에 옮길 때의 확인 사항 {notes.length}개</summary>
          <ul>{notes.map((note, index) => <li key={index} className="small">{note}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
