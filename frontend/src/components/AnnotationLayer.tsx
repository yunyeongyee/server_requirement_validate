import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 서버 그림 위의 설명 라벨과 연결선 (제안서용). 위치는 그림 크기에 대한 %, 그림 밖(음수·100 초과)도 가능 */
export interface Label {
  id: string;
  view: "front" | "rear";
  text: string;
  x: number;
  y: number;
  color: string;
  bold?: boolean;
  size?: number;
  hidden?: boolean;
  locked?: boolean;
}
export interface LinkTarget { kind: "bay" | "slot"; id: string }
export interface Link {
  id: string;
  view: "front" | "rear";
  from: string;
  to: LinkTarget;
  color: string;
  width: number;
  dash: boolean;
  arrowStart: boolean;
  arrowEnd: boolean;
  elbow: boolean;
  hidden?: boolean;
}
export interface Annot { show: boolean; labels: Label[]; links: Link[] }
export const emptyAnnot: Annot = { show: true, labels: [], links: [] };
export interface Rect { x: number; y: number; w: number; h: number }
/** 연결할 수 있는 자리 (베이·슬롯·PSU) — rect 는 그림 크기에 대한 % */
export interface Target { kind: "bay" | "slot"; id: string; name: string; rect: Rect }
export type Selection = { type: "label" | "link"; id: string; ids?: string[] } | null;
export const selIds = (sel: Selection): string[] => sel ? sel.ids?.length ? sel.ids : [sel.id] : [];
export type Tool = "select" | "link";

export const COLORS = ["#2f7de1", "#2fa56a", "#e0364b", "#ee8a1a", "#46597a", "#1b1f24"];
const uid = () => Math.random().toString(36).slice(2, 10);

/** 글자 폭 추정 (px): 영문·숫자는 좁게, 한글은 넓게 */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᇿ㄰-㆏가-힣　-〿]/.test(ch) ? size : size * 0.58;
  return width + 20;
}

/** 라벨·연결선이 쓰는 그림 밖 여백(%) — 본 화면에서 그림 위아래 공간을 확보할 때 */
export function extents(annot: Annot, view: "front" | "rear"): { top: number; bottom: number } {
  let top = 0, bottom = 0;
  if (!annot.show) return { top, bottom };
  annot.labels.filter((label) => label.view === view && !label.hidden).forEach((label) => {
    top = Math.max(top, -(label.y - 9));
    bottom = Math.max(bottom, label.y + 9 - 100);
  });
  return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
}

type Pt = { x: number; y: number };
function edgePoints(r: { l: number; t: number; w: number; h: number }): Array<Pt & { side: "t" | "b" | "l" | "r" }> {
  return [{ x: r.l + r.w / 2, y: r.t, side: "t" }, { x: r.l + r.w / 2, y: r.t + r.h, side: "b" },
    { x: r.l, y: r.t + r.h / 2, side: "l" }, { x: r.l + r.w, y: r.t + r.h / 2, side: "r" }];
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** 라벨 하나 → 연결선 경로(px 점들). 라벨과 부품 각각 서로를 향한 가장자리 중앙에 붙는다 */
export function linkGeometry(link: Link, label: Label, target: Rect, W: number, H: number): { pts: Pt[]; from: Pt; to: Pt } {
  const size = label.size || 13;
  const lw = textWidth(label.text, size), lh = size + 12;
  const lc = { x: label.x / 100 * W, y: label.y / 100 * H };
  const lbox = { l: lc.x - lw / 2, t: lc.y - lh / 2, w: lw, h: lh };
  const tbox = { l: target.x / 100 * W, t: target.y / 100 * H, w: target.w / 100 * W, h: target.h / 100 * H };
  const tc = { x: tbox.l + tbox.w / 2, y: tbox.t + tbox.h / 2 };
  const a = edgePoints(lbox).sort((p, q) => dist(p, tc) - dist(q, tc))[0];
  const b = edgePoints(tbox).sort((p, q) => dist(p, a) - dist(q, a))[0];
  if (!link.elbow) return { pts: [a, b], from: a, to: b };
  const vertical = a.side === "t" || a.side === "b";
  const pts = vertical
    ? [a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b]
    : [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b];
  return { pts, from: a, to: b };
}

interface LayerProps {
  view: "front" | "rear";
  annot: Annot;
  onChange: (next: Annot) => void;
  targets: Target[];
  editable: boolean;
  tool: Tool;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

/** 그림(.chassis) 안에 겹쳐 그리는 라벨·연결선 층. editable 이면 라벨을 끌어 옮기고, 연결선 도구로 라벨에서 부품까지 끌어 연결한다 */
export default function AnnotationLayer({ view, annot, onChange, targets, editable, tool, selection, onSelect }: LayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [snap, setSnap] = useState<Target | null>(null);
  const [drawing, setDrawing] = useState<{ from: string; pos: Pt } | null>(null);
  const drag = useRef<{ start: Pt; orig: Record<string, Pt> } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ W: el.clientWidth, H: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!annot.show) return <div ref={box} className="annot" />;
  const { W, H } = size;
  const labels = annot.labels.filter((label) => label.view === view && !label.hidden);
  const labelById = (id: string) => annot.labels.find((label) => label.id === id);
  const targetOf = (to: LinkTarget) => targets.find((item) => item.kind === to.kind && item.id === to.id);
  const local = (event: { clientX: number; clientY: number }): Pt => {
    const rect = box.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  const hitTarget = (p: Pt): Target | null => {
    const pad = 14;
    return targets.find((item) => {
      const l = item.rect.x / 100 * W - pad, t = item.rect.y / 100 * H - pad;
      return p.x >= l && p.x <= l + item.rect.w / 100 * W + pad * 2 && p.y >= t && p.y <= t + item.rect.h / 100 * H + pad * 2;
    }) || null;
  };

  const startLabel = (event: ReactPointerEvent<HTMLDivElement>, label: Label) => {
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    const p = local(event);
    const current = selIds(selection);
    if (event.shiftKey && selection?.type === "label") {   // Shift+클릭: 여러 라벨 선택 / 해제
      const ids = current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id];
      onSelect(ids.length ? { type: "label", id: ids[ids.length - 1], ids } : null);
      return;
    }
    const ids = selection?.type === "label" && current.includes(label.id) ? current : [label.id];
    onSelect({ type: "label", id: label.id, ids });
    if (tool === "link") {
      setDrawing({ from: label.id, pos: p });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const movable = annot.labels.filter((item) => ids.includes(item.id) && !item.locked);
    if (!movable.length) return;
    drag.current = { start: p, orig: Object.fromEntries(movable.map((item) => [item.id, { x: item.x, y: item.y }])) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveLabel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(event);
    if (drawing) {
      setDrawing({ ...drawing, pos: p });
      setSnap(hitTarget(p));
      return;
    }
    const d = drag.current;
    if (!d || !W || !H) return;
    const dx = (p.x - d.start.x) / W * 100, dy = (p.y - d.start.y) / H * 100;
    onChange({ ...annot, labels: annot.labels.map((item) => d.orig[item.id]
      ? { ...item, x: Math.round((d.orig[item.id].x + dx) * 10) / 10, y: Math.round((d.orig[item.id].y + dy) * 10) / 10 } : item) });
  };
  const endLabel = () => {
    if (drawing && snap) {
      const exists = annot.links.some((link) => link.from === drawing.from && link.to.kind === snap.kind && link.to.id === snap.id);
      if (!exists) {
        const from = labelById(drawing.from);
        const link: Link = { id: uid(), view, from: drawing.from, to: { kind: snap.kind, id: snap.id }, color: from?.color || COLORS[0], width: 2, dash: false, arrowStart: false, arrowEnd: false, elbow: true };
        onChange({ ...annot, links: [...annot.links, link] });
        onSelect({ type: "link", id: link.id });
      }
    }
    setDrawing(null);
    setSnap(null);
    drag.current = null;
  };

  const links = annot.links.filter((link) => link.view === view && !link.hidden);
  const markers = new Set<string>();
  links.forEach((link) => { markers.add(link.color); });
  const drawFrom = drawing ? labelById(drawing.from) : null;

  return (
    <div ref={box} className={`annot ${editable ? "editable" : ""} tool-${tool}`}>
      {!!W && (
        <svg className="annot-svg" width={W} height={H} style={{ overflow: "visible" }}>
          <defs>
            {[...markers].map((color) => (
              <marker key={color} id={`ah-${color.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill={color} />
              </marker>
            ))}
          </defs>
          {links.map((link) => {
            const label = labelById(link.from), target = targetOf(link.to);
            if (!label || label.view !== view || label.hidden || !target) return null;
            const { pts } = linkGeometry(link, label, target.rect, W, H);
            const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
            const selected = selection?.type === "link" && selection.id === link.id;
            const mid = `ah-${link.color.slice(1)}`;
            return (
              <g key={link.id}>
                {selected && <path d={d} fill="none" stroke="#7fb0f5" strokeWidth={link.width + 6} strokeOpacity=".55" strokeLinejoin="round" />}
                <path d={d} fill="none" stroke={link.color} strokeWidth={link.width} strokeDasharray={link.dash ? "7 5" : undefined} strokeLinejoin="round"
                  markerEnd={link.arrowEnd ? `url(#${mid})` : undefined} markerStart={link.arrowStart ? `url(#${mid})` : undefined} />
                {!link.arrowEnd && <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={link.width + 1.5} fill={link.color} />}
                {editable && <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: "stroke", cursor: "pointer" }} onPointerDown={(event) => { event.stopPropagation(); onSelect({ type: "link", id: link.id }); }} />}
              </g>
            );
          })}
          {drawing && drawFrom && (
            <path d={`M${drawFrom.x / 100 * W} ${drawFrom.y / 100 * H} L${drawing.pos.x} ${drawing.pos.y}`} stroke="#20c997" strokeWidth={2} strokeDasharray="5 4" fill="none" />
          )}
        </svg>
      )}
      {editable && drawing && targets.map((item) => (
        <i key={`${item.kind}:${item.id}`} className={`snap-target ${snap?.kind === item.kind && snap.id === item.id ? "on" : ""}`}
          style={{ left: `${item.rect.x}%`, top: `${item.rect.y}%`, width: `${item.rect.w}%`, height: `${item.rect.h}%` }}>
          {snap?.kind === item.kind && snap.id === item.id && <b>{item.name} 에 연결</b>}
        </i>
      ))}
      {labels.map((label) => (
        <div key={label.id}
          className={`annot-label ${selection?.type === "label" && selIds(selection).includes(label.id) ? "sel" : ""} ${label.locked ? "locked" : ""}`}
          style={{ left: `${label.x}%`, top: `${label.y}%`, borderColor: label.color, color: label.color, fontWeight: label.bold ? 700 : 500, fontSize: label.size || 13 }}
          onPointerDown={(event) => startLabel(event, label)} onPointerMove={moveLabel} onPointerUp={endLabel} onPointerCancel={endLabel}>
          {label.text || "(빈 라벨)"}{label.locked && <em aria-hidden="true"> 🔒</em>}
        </div>
      ))}
    </div>
  );
}

/** 상단 도구 모음 */
export function AnnotToolbar({ annot, tool, setTool, selection, onChange, onAdd, onAuto, view, onLoadSaved }: {
  annot: Annot; tool: Tool; setTool: (t: Tool) => void; selection: Selection; onChange: (next: Annot) => void; onAdd: () => void; onAuto: () => void; view: "front" | "rear"; onLoadSaved?: () => void;
}) {
  const link = selection?.type === "link" ? annot.links.find((item) => item.id === selection.id) : undefined;
  const chosen = selection?.type === "label" ? selIds(selection) : [];
  const label = chosen.length ? annot.labels.find((item) => item.id === chosen[chosen.length - 1]) : undefined;
  const setLink = (patch: Partial<Link>) => link && onChange({ ...annot, links: annot.links.map((item) => item.id === link.id ? { ...item, ...patch } : item) });
  const setLabel = (patch: Partial<Label>) => label && onChange({ ...annot, labels: annot.labels.map((item) => chosen.includes(item.id) ? { ...item, ...patch } : item) });
  const remove = () => {
    if (link) onChange({ ...annot, links: annot.links.filter((item) => item.id !== link.id) });
    else if (label) onChange({ ...annot, labels: annot.labels.filter((item) => !chosen.includes(item.id)), links: annot.links.filter((item) => !chosen.includes(item.from)) });
  };
  const btn = (text: string, title: string, on: boolean, onClick: () => void, key?: string) => (
    <button key={key || text} type="button" className={`atb ${on ? "on" : ""}`} title={title} aria-pressed={on} onClick={onClick}>{text}</button>
  );
  return (
    <div className="atoolbar" role="toolbar" aria-label="라벨·연결선 도구">
      {btn("↖ 선택", "라벨을 끌어 옮기고 선택합니다", tool === "select", () => setTool("select"))}
      {btn("⟋ 연결선", "라벨에서 부품까지 끌어 연결합니다 — 부품 가까이 가면 자석처럼 붙습니다", tool === "link", () => setTool("link"))}
      <button type="button" className="atb" title="새 라벨 추가" onClick={onAdd}>＋ 라벨</button>
      <button type="button" className="atb" title="지금 구성으로 라벨과 연결선을 자동으로 만듭니다 (이 면의 기존 라벨은 대체)" onClick={onAuto}>↺ 자동 배치</button>
      <i className="asep" />
      {(link || label) ? <>
        <span className="swatches" role="group" aria-label="색">
          {COLORS.map((color) => <button key={color} type="button" className={`sw ${((link || label)?.color === color) ? "on" : ""}`} style={{ background: color }} aria-label={`색 ${color}`}
            onClick={() => link ? setLink({ color }) : setLabel({ color })} />)}
        </span>
        {link && <>
          {btn("굵게", "선 굵기", link.width >= 3, () => setLink({ width: link.width >= 3 ? 2 : 4 }), "w")}
          {btn("┅ 점선", "점선", link.dash, () => setLink({ dash: !link.dash }), "d")}
          {btn("⟵", "시작 화살표", link.arrowStart, () => setLink({ arrowStart: !link.arrowStart }), "as")}
          {btn("⟶", "끝 화살표", link.arrowEnd, () => setLink({ arrowEnd: !link.arrowEnd }), "ae")}
          {btn("⌐ 꺾임", "꺾인 선 / 직선", link.elbow, () => setLink({ elbow: !link.elbow }), "e")}
        </>}
        {label && <>
          {btn("B", "굵게", !!label.bold, () => setLabel({ bold: !label.bold }), "b")}
          {btn("🔒", "위치 고정", !!label.locked, () => setLabel({ locked: !label.locked }), "l")}
          {btn("숨김", "이 라벨 숨기기", !!label.hidden, () => setLabel({ hidden: !label.hidden }), "h")}
        </>}
        <button type="button" className="atb danger" title="선택한 라벨(연결된 선 포함) 또는 선 삭제" onClick={remove}>⌫ 삭제{chosen.length > 1 ? ` (${chosen.length})` : ""}</button>
      </> : <span className="muted small">{annot.labels.filter((item) => item.view === view).length ? "라벨이나 선을 눌러 고르세요" : "‘↺ 자동 배치’로 시작하거나 ‘＋ 라벨’로 직접 추가하세요"}</span>}
      <span className="atb-right">
        <span className="muted small" title="이 서버 모델 기준으로 브라우저에 자동 저장됩니다">자동 저장됨</span>
        {onLoadSaved && <button type="button" className="atb" title="이 서버 모델로 마지막에 편집한 라벨 배치를 불러옵니다" onClick={onLoadSaved}>저장된 배치 불러오기</button>}
        {btn(annot.show ? "◉ 라벨 켜짐" : "○ 라벨 꺼짐", "전면·후면 라벨과 선을 한꺼번에 켜고 끕니다", annot.show, () => onChange({ ...annot, show: !annot.show }), "show")}
      </span>
    </div>
  );
}

/** 오른쪽 속성 패널(라벨 모드) */
export function AnnotPanel({ annot, selection, onChange, onSelect, targets, view }: {
  annot: Annot; selection: Selection; onChange: (next: Annot) => void; onSelect: (s: Selection) => void; targets: Target[]; view: "front" | "rear";
}) {
  const ids = selection?.type === "label" ? selIds(selection) : [];
  const label = ids.length ? annot.labels.find((item) => item.id === ids[ids.length - 1]) : undefined;
  const link = selection?.type === "link" ? annot.links.find((item) => item.id === selection.id) : undefined;
  const set = (patch: Partial<Label>) => label && onChange({ ...annot, labels: annot.labels.map((item) => item.id === label.id ? { ...item, ...patch } : item) });
  const nameOf = (to: LinkTarget) => targets.find((item) => item.kind === to.kind && item.id === to.id)?.name || to.id;
  if (link) {
    const from = annot.labels.find((item) => item.id === link.from);
    return <>
      <p><b>연결선</b></p>
      <p className="small">{from?.text || "?"} → {nameOf(link.to)}</p>
      <p className="muted small">라벨을 옮겨도 선은 연결된 부품을 계속 가리킵니다. 색·굵기·화살표는 위 도구 막대에서 바꿉니다.</p>
      <button type="button" className="btn ghost small" onClick={() => onChange({ ...annot, links: annot.links.map((item) => item.id === link.id ? { ...item, hidden: !item.hidden } : item) })}>{link.hidden ? "선 보이기" : "선 숨기기"}</button>
    </>;
  }
  if (label && ids.length > 1) {
    return <>
      <p><b>라벨 {ids.length}개 선택</b></p>
      <p className="muted small">끌면 함께 움직입니다. 색·굵게·고정·삭제는 위 도구 막대에서 한꺼번에 바뀝니다. Shift+클릭으로 더하거나 뺍니다.</p>
      <button type="button" className="lnk small" onClick={() => onSelect({ type: "label", id: label.id })}>하나만 선택</button>
    </>;
  }
  if (label) {
    const mine = annot.links.filter((item) => item.from === label.id);
    return <>
      <p><b>라벨</b></p>
      <label className="small">내용<textarea aria-label="라벨 내용" rows={3} value={label.text} onChange={(event) => set({ text: event.target.value })} /></label>
      <label className="small">글자 크기
        <input type="range" min={10} max={24} value={label.size || 13} onChange={(event) => set({ size: Number(event.target.value) })} /> {label.size || 13}px
      </label>
      <p className="small">연결된 부품: {mine.length ? mine.map((item) => nameOf(item.to)).join(", ") : "없음"}</p>
      <p className="muted small">‘⟋ 연결선’ 도구로 이 라벨을 끌어 부품에 연결합니다.</p>
      {mine.map((item) => <button key={item.id} type="button" className="lnk small" onClick={() => onSelect({ type: "link", id: item.id })}>선: {nameOf(item.to)}</button>)}
    </>;
  }
  const mineLabels = annot.labels.filter((item) => item.view === view);
  return <>
    <p><b>라벨·연결선</b></p>
    <p className="muted small">라벨 {mineLabels.length}개 · 선 {annot.links.filter((item) => item.view === view).length}개 ({view === "front" ? "전면" : "후면"})</p>
    <p className="muted small">라벨은 끌어서 옮기고, ‘⟋ 연결선’ 도구로 라벨에서 부품까지 끌어 연결합니다. 부품 가까이 가면 초록색으로 강조되며 붙습니다. 편집한 내용은 창을 닫아도 유지되고 본 화면과 PNG에 반영됩니다.</p>
    {!!mineLabels.length && <button type="button" className="btn ghost small" onClick={() => onSelect({ type: "label", id: mineLabels[mineLabels.length - 1].id, ids: mineLabels.map((item) => item.id) })}>이 면 라벨 모두 선택</button>}
    {mineLabels.map((item) => <button key={item.id} type="button" className="lnk small block" onClick={() => onSelect({ type: "label", id: item.id })}>{item.text || "(빈 라벨)"}</button>)}
  </>;
}

export function newLabel(view: "front" | "rear", text = "새 라벨"): Label {
  return { id: uid(), view, text, x: 50, y: view === "rear" ? -12 : 112, color: COLORS[0] };
}

/** 지금 구성으로 라벨·연결선 자동 만들기. groups: 같은 품명끼리 묶은 항목(여러 부품에 선 여러 개) */
export function buildAuto(view: "front" | "rear", groups: Array<{ text: string; color: string; targets: Target[] }>, textSize = 13): { labels: Label[]; links: Link[] } {
  type Item = { text: string; color: string; targets: Target[]; cx: number; top: boolean; w: number };
  const items: Item[] = groups.filter((group) => group.targets.length).map((group) => {
    const cx = group.targets.reduce((sum, t) => sum + t.rect.x + t.rect.w / 2, 0) / group.targets.length;
    const cy = group.targets.reduce((sum, t) => sum + t.rect.y + t.rect.h / 2, 0) / group.targets.length;
    return { ...group, cx, top: view === "rear" ? cy < 50 : false, w: textWidth(group.text, textSize) };
  });
  const labels: Label[] = [], links: Link[] = [];
  const perPct = 0.075;   // 그림 폭 1200px 기준 대략 % 환산 (겹침 방지용)
  [true, false].forEach((top) => {
    const side = items.filter((item) => item.top === top).sort((a, b) => a.cx - b.cx);
    const rows: Array<Array<{ x: number; w: number }>> = [];
    side.forEach((item) => {
      const w = item.w * perPct;
      let x = Math.min(Math.max(item.cx, w / 2 + 1), 99 - w / 2);
      let row = rows.findIndex((r) => r.every((o) => Math.abs(o.x - x) >= (o.w + w) / 2 + 1));
      if (row < 0) { rows.push([]); row = rows.length - 1; }
      rows[row].push({ x, w });
      const label: Label = { ...newLabel(view, item.text), x: Math.round(x * 10) / 10, y: top ? -10 - row * 14 : 110 + row * 14, color: item.color };
      labels.push(label);
      item.targets.forEach((target) => links.push({ id: uid(), view, from: label.id, to: { kind: target.kind, id: target.id }, color: item.color, width: 2, dash: false, arrowStart: false, arrowEnd: false, elbow: true }));
    });
  });
  return { labels, links };
}
