import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import type { Component, ImageStatus, Server, ServerConfig, ValidationResult } from "../types";
import type { ConfigDiff } from "../configDiff";

interface Props {
  server: Server | null;
  apiReady: boolean | null;
  components: Component[];
  config: ServerConfig | null;
  result: ValidationResult | null;
  images: ImageStatus | null;
  renderedImages: RenderedImages;
  onChange: (config: ServerConfig) => void;
  onBackplaneChange: (id: string) => void;
  onSaveCalibration: (hotspots: Record<string, Rect>, rects: Rect[]) => Promise<void>;
  onRedetectBays: () => Promise<void>;
  /** 카드 머리에 들어갈 모델 줄 (모델 · 출처 · 변경) */
  modelLine: ReactNode;
  /** 요구사항 행의 '추가/수정' 버튼이 보낸 요청. n 이 바뀔 때마다 처리 */
  focus: FocusRequest | null;
  onOpenImages: () => void;
  /** 직접 고른 전면 이미지를 해제해 자동(스텐실 이름 매칭)으로 */
  onUseAutoFront: () => Promise<void>;
  /** 카드 맨 위에 넣을 견적 붙여넣기·요약 */
  quotePanel?: ReactNode;
  /** 견적 대비 변경 (그림에서 직접 바꾼 곳) */
  diff?: ConfigDiff | null;
}

/** 서버가 합성한 전면/후면 그림과, 그 그림을 만든 구성 (화면 미리보기와 비교용) */
export interface RenderedImages {
  front: string | null;
  rear: string | null;
  config?: ServerConfig;
}

export interface FocusRequest {
  kind: "slot" | "spec" | "bays";
  part?: "fc" | "nic" | "gpu" | "psu" | "cpu" | "memory" | "raid";
  /** 어떤 요구사항 때문에 왔는지 — 팝오버에 그대로 보여 준다 */
  need?: string;
  n: number;
}

const DISK_MSG = /RAID|Boot|Data|디스크|백플레인|BOSS/;
const PSU_MSG = /PSU|전원|소비전력/;
const RAID_LEVELS = ["", "RAID0", "RAID1", "RAID5", "RAID6", "RAID10"];

function driveGb(name: string): number {
  const match = name.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  return match ? Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1000 : 1) : 0;
}

/** RAID 수준별 사용 가능 용량(같은 용량 디스크 기준 추정). 구성 불가면 null */
function usableGb(level: string, count: number, size: number): number | null {
  if (!count) return 0;
  switch (level) {
    case "": case "RAID0": return count * size;
    case "RAID1": return count === 2 ? size : null;
    case "RAID5": return count >= 3 ? (count - 1) * size : null;
    case "RAID6": return count >= 4 ? (count - 2) * size : null;
    case "RAID10": return count >= 4 && count % 2 === 0 ? (count / 2) * size : null;
    default: return null;
  }
}

function formatGb(gb: number): string {
  return gb >= 1000 ? `${(gb / 1000).toFixed(gb % 1000 ? 2 : 0)}TB` : `${gb}GB`;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 가림 영역(blk:N)일 때 마우스를 올리면 보여줄 이유 */
  reason?: string;
}

const BLOCK_REASON = "이 모델 데이터에 없는 영역이라 사용할 수 없습니다";

/** 저장된 슬롯·PSU·가림 영역 좌표 → 편집용 맵 */
function savedHotspots(server: Server | null): Record<string, Rect> {
  const next: Record<string, Rect> = {};
  [...(server?.slots || []), ...(server?.psu_slots || [])].forEach((slot) => {
    if (slot.hotspot) next[slot.id] = { ...slot.hotspot };
  });
  (server?.rear_blocked || []).forEach((area, index) => { next[`blk:${index}`] = { ...area }; });
  return next;
}

interface DragState {
  view: "front" | "rear";
  key: string;
  box: DOMRect;
  startX: number;
  startY: number;
  initial: Rect;
  resize: boolean;
}

export default function ConfigSection({
  server,
  apiReady,
  components,
  config,
  result,
  images,
  renderedImages,
  onChange,
  onBackplaneChange,
  onSaveCalibration,
  onRedetectBays,
  modelLine,
  focus,
  onOpenImages,
  onUseAutoFront,
  quotePanel,
  diff,
}: Props) {
  const [mode, setMode] = useState<"edit" | "calib">("edit");
  const [selectedBays, setSelectedBays] = useState<number[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 확대 창으로 보고 있는 면 */
  const [zoom, setZoom] = useState<"front" | "rear" | null>(null);
  /** 확대 창 안의 그림 배율 (Ctrl + / Ctrl − / Ctrl 0, Ctrl+휠) */
  const [scale, setScale] = useState(1);
  /** 좌표 보정 중 방향키로 움직일 영역 (마지막으로 끌거나 누른 것) */
  const [calibSel, setCalibSel] = useState<{ view: "front" | "rear"; key: string } | null>(null);
  const [showSlotList, setShowSlotList] = useState(false);
  /** 한 줄 사양 중 펼친 것 (CPU / MEM / Disk / PSU) */
  const [specOpen, setSpecOpen] = useState<"cpu" | "mem" | "disk" | "psu" | null>(null);
  /** 팝오버에 보여 줄 '이 요구사항 때문에 왔다' · 맞는 자리가 없을 때 안내 */
  const [need, setNeed] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ view: "front" | "rear"; text: string } | null>(null);
  /** 팝오버에서 고른 꽂을 디스크 종류·용도 (마지막에 고른 값 유지) */
  const [diskChoice, setDiskChoice] = useState("");
  const [roleChoice, setRoleChoice] = useState<"data" | "boot">("data");
  const specRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLElement>(null);
  const rearRef = useRef<HTMLElement>(null);
  /** Shift+클릭 기준 베이, 드래그로 여러 칸 고르기 */
  const anchorBay = useRef<number | null>(null);
  const bayDrag = useRef<{ anchor: number; base: number[] } | null>(null);
  /** 드래그가 끝나면 브라우저가 공통 부모(빈 곳)에 click 을 보낸다 → 선택 해제로 오인하지 않게 */
  const dragged = useRef(false);
  const [frontRects, setFrontRects] = useState<Rect[]>([]);
  const [slotHotspots, setSlotHotspots] = useState<Record<string, Rect>>({});
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState("");
  const drag = useRef<DragState | null>(null);
  // 완료 메시지는 잠깐 보여주고 지운다 (오류는 남김)
  useEffect(() => {
    if (!calibrationMessage || calibrationMessage.includes("오류")) return;
    const timer = window.setTimeout(() => setCalibrationMessage(""), 2500);
    return () => window.clearTimeout(timer);
  }, [calibrationMessage]);
  const reveal = (ref: { current: HTMLElement | null }) =>
    window.setTimeout(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  const openSpec = (key: "cpu" | "mem" | "disk" | "psu") => {
    setSpecOpen(key);
    reveal(specRef);
  };
  const clearSelection = () => {
    setSelectedBays([]);
    setSelectedSlot(null);
    setNeed(null);
    setNotice(null);
    anchorBay.current = null;
  };
  // 모델·백플레인이 바뀌면 이전 선택은 의미가 없다
  useEffect(() => { clearSelection(); }, [server?.id, config?.backplane]);
  // 팝오버·메뉴 밖을 누르면 닫는다
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(".tools")) setMenuOpen(false);
      if (!target.closest(".pop, .zoompanel, .zoomhead, .calibbar, .bay, .hs, .fix, .sline, select, option")) clearSelection();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, []);
  useEffect(() => {
    const stop = () => { bayDrag.current = null; };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, []);

  useEffect(() => {
    setFrontRects(images?.bays.rects || []);
  }, [server?.id, config?.backplane, images?.bays.rects]);
  useEffect(() => {
    setSlotHotspots(savedHotspots(server));
  }, [server]);

  useEffect(() => { if (mode !== "calib") setCalibSel(null); }, [mode]);
  useEffect(() => { if (zoom === null) setScale(1); }, [zoom]);
  useEffect(() => {
    if (zoom === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setScale((value) => Math.min(5, Math.max(1, Math.round((value + (event.deltaY < 0 ? 0.25 : -0.25)) * 100) / 100)));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [zoom]);
  // 방향키: 확대 창에서는 선택 이동(Shift 확장), 좌표 보정에서는 영역 이동(Alt 크기) · 기본 0.1%, Shift 1%
  useEffect(() => {
    if (!server || !config) return;
    if (zoom === null && !(mode === "calib" && calibSel)) return;
    const clamp = (value: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, value)) * 100) / 100;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === "Escape" && zoom !== null) { setZoom(null); return; }
      if (zoom !== null && (event.ctrlKey || event.metaKey) && ["+", "=", "-", "_", "0"].includes(event.key)) {
        event.preventDefault();   // 브라우저 전체 확대 대신 그림만 확대
        setScale((value) => event.key === "0" ? 1 : Math.min(5, Math.max(1, Math.round((value + (event.key === "-" || event.key === "_" ? -0.25 : 0.25)) * 100) / 100)));
        return;
      }
      const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
      if (!dir || event.ctrlKey || event.metaKey) return;
      if (mode === "calib") {
        if (!calibSel) return;
        const cur = calibSel.view === "front" ? frontRects[Number(calibSel.key)] : slotHotspots[calibSel.key];
        if (!cur) return;
        event.preventDefault();
        const step = event.shiftKey ? 1 : 0.1;
        const next = event.altKey
          ? { ...cur, w: clamp(cur.w + dir[0] * step, 0.5, 100 - cur.x), h: clamp(cur.h + dir[1] * step, 0.5, 100 - cur.y) }
          : { ...cur, x: clamp(cur.x + dir[0] * step, 0, 100 - cur.w), y: clamp(cur.y + dir[1] * step, 0, 100 - cur.h) };
        if (calibSel.view === "front") setFrontRects((current) => current.map((rect, index) => index === Number(calibSel.key) ? next : rect));
        else setSlotHotspots((current) => ({ ...current, [calibSel.key]: next }));
        return;
      }
      if (zoom === null) return;
      event.preventDefault();
      const items: Array<{ id: string; r: Rect }> = zoom === "front"
        ? frontRects.map((r, index) => ({ id: String(index), r }))
        : [...server.slots, ...(server.psu_slots || [])].flatMap((slot) => slotHotspots[slot.id] ? [{ id: slot.id, r: slotHotspots[slot.id] }] : []);
      if (!items.length) return;
      const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      const currentId = zoom === "front" ? (anchorBay.current ?? selectedBays[selectedBays.length - 1])?.toString() : selectedSlot || undefined;
      const from = items.find((item) => item.id === currentId);
      let pick = from ? undefined : [...items].sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x)[0];
      if (from) {
        const c = center(from.r);
        let best = Infinity;
        items.forEach((item) => {
          if (item === from) return;
          const o = center(item.r);
          const dx = o.x - c.x, dy = o.y - c.y;
          if (dir[0] ? dx * dir[0] <= 0.01 : dy * dir[1] <= 0.01) return;
          const score = dir[0] ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx);
          if (score < best) { best = score; pick = item; }
        });
      }
      if (!pick) return;
      if (zoom === "front") {
        const index = Number(pick.id);
        setSelectedSlot(null);
        setSelectedBays((current) => event.shiftKey && from ? [...new Set([...current, index])].sort((a, b) => a - b) : [index]);
        anchorBay.current = index;
      } else {
        setSelectedBays([]);
        setSelectedSlot(pick.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, mode, calibSel, selectedBays, selectedSlot, frontRects, slotHotspots, server, config]);

  useEffect(() => {
    if (!focus || !server || !config) return;
    clearSelection();
    setNeed(focus.need || null);
    if (focus.kind === "bays") {
      if (focus.part === "raid") { openSpec("disk"); return; }
      // 디스크 요구: 빈 베이를 모두 골라 두고 팝오버에서 '꽂기'만 누르면 되게
      const total = server.backplanes.find((item) => item.id === config.backplane)?.bays || 0;
      const empty = Array.from({ length: total }, (_, index) => index).filter((index) => !config.bays[String(index)]);
      if (!empty.length) { setNotice({ view: "front", text: "전면 베이가 모두 차 있습니다 — 디스크를 바꾸려면 베이를 클릭하세요" }); reveal(frontRef); return; }
      setSelectedBays(empty);
      reveal(frontRef);
    } else if (focus.kind === "spec") {
      openSpec(focus.part === "memory" ? "mem" : "cpu");
    } else if (focus.kind === "slot" && focus.part === "psu") {
      const psuSlotList = server.psu_slots || [];
      const target = psuSlotList[Math.min(config.psu_count || 0, psuSlotList.length - 1)];
      if (target) { setSelectedSlot(target.id); reveal(rearRef); } else openSpec("psu");
    } else if (focus.kind === "slot") {
      // 필요한 부품이 실제로 들어가는 빈 슬롯을 찾는다 (자리·크기·CPU/Riser 조건)
      const wanted = components.filter((item) => focus.part === "fc" ? item.category === "FC HBA"
        : focus.part === "gpu" ? item.category === "GPU" : item.category === "NIC" || item.category === "OCP NIC");
      const fitsSlot = (slot: Server["slots"][number]) => wanted.some((item) =>
        (slot.type === "ocp" ? item.form === "ocp" : item.form !== "ocp") && item.lanes <= slot.lanes
        && !(item.height === "FH" && slot.height === "LP") && !(item.double_width && !slot.double_width_ok));
      const free = server.slots.find((slot) => !config.slots[slot.id] && fitsSlot(slot)
        && (result?.slots.find((item) => item.slot === slot.id)?.usable ?? true));
      if (free) { setSelectedSlot(free.id); reveal(rearRef); }
      else { setNotice({ view: "rear", text: "이 구성에는 맞는 빈 슬롯이 없습니다 — 다른 슬롯의 부품을 바꾸거나 Riser·CPU 구성을 확인하세요" }); reveal(rearRef); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  if (!server || !config) return (
    <section id="s3" className="card cfg">
      <div className="cardhead">{modelLine}</div>
      <p className="muted pad">{apiReady === false ? "API 연결 후 서버 구성을 편집할 수 있습니다." : "서버 구성을 불러오는 중입니다."}</p>
    </section>
  );

  const backplane = server.backplanes.find((item) => item.id === config.backplane) || server.backplanes[0];
  const memoryTotal = config.memory.reduce((total, row) => total + row.size_gb * row.qty, 0);
  const memoryCount = config.memory.reduce((total, row) => total + row.qty, 0);
  const getSlotResult = (slotId: string) => result?.slots.find((item) => item.slot === slotId);
  const getBayResult = (bay: number) => result?.bays.find((item) => item.bay === bay);
  const patch = (values: Partial<ServerConfig>) => onChange({ ...config, ...values });

  const driveOptions = server.drive_options.filter((drive) => drive.ff === backplane.ff);
  const currentDrive = driveOptions.find((drive) => drive.id === diskChoice)?.id || driveOptions[0]?.id || "";
  const range = (a: number, b: number) => Array.from({ length: Math.abs(a - b) + 1 }, (_, index) => Math.min(a, b) + index);
  const union = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
  /** 클릭 = 선택만. Shift = 기준 칸부터 범위, Ctrl/⌘ = 한 칸 더하기/빼기, 드래그 = 여러 칸 */
  const pressBay = (bay: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    setSelectedSlot(null);
    dragged.current = false;
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchorBay.current !== null) {
      const next = union(additive ? selectedBays : [], range(anchorBay.current, bay));
      setSelectedBays(next);
      bayDrag.current = { anchor: anchorBay.current, base: additive ? selectedBays : [] };
      return;
    }
    anchorBay.current = bay;
    if (additive) {
      const next = selectedBays.includes(bay) ? selectedBays.filter((item) => item !== bay) : union(selectedBays, [bay]);
      setSelectedBays(next);
      bayDrag.current = { anchor: bay, base: next };
      return;
    }
    const only = selectedBays.length === 1 && selectedBays[0] === bay;
    setSelectedBays(only ? [] : [bay]);
    bayDrag.current = { anchor: bay, base: [] };
  };
  const dragOverBay = (bay: number) => {
    const active = bayDrag.current;
    if (!active) return;
    dragged.current = true;
    setSelectedBays(union(active.base, range(active.anchor, bay)));
  };
  const selectedSorted = [...selectedBays].sort((a, b) => a - b);
  const filledSel = selectedSorted.filter((index) => config.bays[String(index)]);
  const emptySel = selectedSorted.filter((index) => !config.bays[String(index)]);
  /** 꽂힌 칸의 종류·용도를 바로 바꾼다 (빈 칸은 '꽂기'를 눌러야) */
  const changeFilled = (values: Partial<{ drive: string; role: "data" | "boot" }>) => {
    if (!filledSel.length) return;
    const bays = { ...config.bays };
    filledSel.forEach((index) => { bays[String(index)] = { ...bays[String(index)], ...values }; });
    patch({ bays });
  };
  const installSelected = () => {
    if (!emptySel.length || !currentDrive) return;
    const bays = { ...config.bays };
    emptySel.forEach((index) => { bays[String(index)] = { drive: currentDrive, role: roleChoice }; });
    patch({ bays });
  };
  const removeBays = () => {
    if (!filledSel.length) return;
    const bays = { ...config.bays };
    filledSel.forEach((index) => delete bays[String(index)]);
    patch({ bays });
  };

  const updateMemory = (index: number, values: Partial<ServerConfig["memory"][number]>) => {
    patch({ memory: config.memory.map((row, rowIndex) => rowIndex === index ? { ...row, ...values } : row) });
  };

  const currentFrontRects = frontRects;
  const candidates = images?.bays.candidates || [];
  const covers = (rect: Rect, other: Rect) => {
    const cx = other.x + other.w / 2, cy = other.y + other.h / 2;
    return cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h;
  };
  const freeCandidates = candidates.filter((candidate) => !currentFrontRects.some((rect) => covers(rect, candidate) || covers(candidate, rect)));
  const sortRects = (rects: Rect[]) => [...rects].sort((a, b) => Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x);
  const imageBayMismatch = candidates.length > 0 && candidates.length !== backplane.bays;
  const matchingBackplane = imageBayMismatch
    ? server.backplanes.find((item) => item.bays === candidates.length && item.ff === backplane.ff)
    : undefined;
  /** 첫 베이 크기를 전체에 적용하고, 첫·마지막 베이 사이를 같은 간격으로 채운다 (한 줄 기준) */
  const distributeBays = () => {
    const rects = currentFrontRects;
    const n = backplane.bays;
    if (!rects.length) return;
    const first = rects[0];
    const last = rects.length > 1 ? rects[rects.length - 1] : { ...first, x: Math.min(100 - first.w, first.x + first.w * 1.1 * (n - 1)) };
    const step = n > 1 ? { x: (last.x - first.x) / (n - 1), y: (last.y - first.y) / (n - 1) } : { x: 0, y: 0 };
    setFrontRects(Array.from({ length: n }, (_, index) => ({ x: first.x + step.x * index, y: first.y + step.y * index, w: first.w, h: first.h })));
    setCalibrationMessage(`Bay 0 크기로 ${n}개를 같은 간격으로 배치했습니다. 확인 후 '저장하고 끝내기'를 누르세요.`);
  };
  const copyFirstSize = () => {
    const first = currentFrontRects[0];
    if (!first) return;
    setFrontRects(currentFrontRects.map((rect) => ({ ...rect, w: first.w, h: first.h, y: first.y })));
    setCalibrationMessage("Bay 0 크기와 높이를 전체 베이에 적용했습니다.");
  };
  const useCandidates = (from: "start" | "end") => {
    const ordered = sortRects(candidates);
    setFrontRects(from === "start" ? ordered.slice(0, backplane.bays) : ordered.slice(-backplane.bays));
    setCalibrationMessage("사용할 베이를 바꿨습니다. '저장하고 끝내기'를 눌러야 반영됩니다.");
  };
  const startDrag = (view: "front" | "rear", event: PointerEvent<HTMLDivElement>) => {
    if (mode !== "calib") return;
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".hs, .bay") : null;
    const key = target?.dataset.calibKey;
    if (!target || !key) return;
    const box = target.parentElement?.getBoundingClientRect();
    const initial = view === "front" ? currentFrontRects[Number(key)] : slotHotspots[key];
    if (!box || !initial) return;
    setCalibSel({ view, key });
    drag.current = {
      view, key, box, startX: event.clientX, startY: event.clientY,
      initial: { ...initial },
      resize: event.target instanceof HTMLElement && event.target.classList.contains("grip"),
    };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active) return;
    const dx = (event.clientX - active.startX) / active.box.width * 100;
    const dy = (event.clientY - active.startY) / active.box.height * 100;
    const next = active.resize
      ? { ...active.initial, w: Math.max(0.5, active.initial.w + dx), h: Math.max(2, active.initial.h + dy) }
      : {
        ...active.initial,
        x: Math.min(100 - active.initial.w, Math.max(0, active.initial.x + dx)),
        y: Math.min(100 - active.initial.h, Math.max(0, active.initial.y + dy)),
      };
    if (active.view === "front") {
      setFrontRects((current) => current.map((rect, index) => index === Number(active.key) ? next : rect));
    } else {
      setSlotHotspots((current) => ({ ...current, [active.key]: next }));
    }
  };

  const saveCalibration = async () => {
    setCalibrationBusy(true);
    setCalibrationMessage("");
    try {
      // 가림 영역은 삭제로 번호가 비었을 수 있어 0부터 다시 매긴다
      const plain = Object.fromEntries(Object.entries(slotHotspots).filter(([key]) => !key.startsWith("blk:")));
      const blocks = Object.entries(slotHotspots).filter(([key]) => key.startsWith("blk:"))
        .sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)))
        .map(([, area], index) => [`blk:${index}`, area] as const);
      await onSaveCalibration({ ...plain, ...Object.fromEntries(blocks) }, currentFrontRects);
      setCalibrationMessage("좌표를 저장했습니다");
      setMode("edit");
    } catch (reason) {
      setCalibrationMessage(`저장 오류: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setCalibrationBusy(false);
    }
  };

  const redetect = async () => {
    setCalibrationBusy(true);
    setCalibrationMessage("");
    try {
      await onRedetectBays();
      setCalibrationMessage("베이 자동 감지 완료");
    } catch (reason) {
      setCalibrationMessage(`감지 오류: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setCalibrationBusy(false);
    }
  };

  const psuSlots = (server.psu_slots || []).map((psu) => ({
    ...psu, type: "psu", gen: 0, lanes: 0, height: "", double_width_ok: false, cpu: 0, riser: null,
  }));
  const unusableReason = (slot: { id: string; cpu: number; riser: string | null; label: string }) => {
    if (slot.cpu > config.cpu_count) return `${slot.label}은 CPU${slot.cpu}에 연결된 슬롯입니다. CPU를 ${slot.cpu}개 이상 장착해야 쓸 수 있습니다.`;
    if (slot.riser && !config.risers.includes(slot.riser)) return `${slot.label}은 ${server.risers.find((riser) => riser.id === slot.riser)?.name || slot.riser}가 있어야 쓸 수 있습니다. 클릭해서 Riser를 장착하세요.`;
    return `${slot.label}은 지금 구성에서 쓸 수 없습니다.`;
  };
  // 후면 슬롯·PSU 위치는 실제 이미지에서 보정한(저장된) 좌표
  const rearSpot = (id: string): Rect | undefined => slotHotspots[id];
  const psuIndex = (id: string) => psuSlots.findIndex((psu) => psu.id === id);
  const psuWarn = !!result?.general.some((item) => item.status !== "충족" && /PSU|전원|소비전력/.test(item.msg));

  /** 좁은 베이(E3.S 등)는 옆 칸과의 틈 절반까지 클릭 영역을 넓힌다. 보정 중에는 실제 크기 그대로 */
  const bayPads = currentFrontRects.map((rect) => {
    if (mode !== "edit") return { padL: 0, padR: 0 };
    const sameRow = currentFrontRects.filter((other) => other !== rect
      && Math.min(other.y + other.h, rect.y + rect.h) - Math.max(other.y, rect.y) > Math.min(other.h, rect.h) / 2);
    const gapLeft = Math.min(...sameRow.map((other) => rect.x - (other.x + other.w)).filter((gap) => gap >= 0));
    const gapRight = Math.min(...sameRow.map((other) => other.x - (rect.x + rect.w)).filter((gap) => gap >= 0));
    const cap = rect.w * 0.5;
    return {
      padL: Number.isFinite(gapLeft) ? Math.min(gapLeft / 2, cap) : 0,
      padR: Number.isFinite(gapRight) ? Math.min(gapRight / 2, cap) : 0,
    };
  });

  const selectedPsu = selectedSlot ? psuIndex(selectedSlot) : -1;

  // ── 한 줄 사양 (CPU / MEM / Disk / PSU) ──
  const driveShort = (id: string) => (server.drive_options.find((item) => item.id === id)?.name || id).replace(/\s*[23]\.5"/, "");
  const diskGroups = (() => {
    const counts = new Map<string, number>();
    Object.values(config.bays).forEach((bay) => counts.set(bay.drive, (counts.get(bay.drive) || 0) + 1));
    return [...counts];
  })();
  const diskSummary = diskGroups.length
    ? diskGroups.map(([id, count]) => `${driveShort(id)} · ${count} EA`).join(" + ") + (config.boss ? " + BOSS M.2" : "")
    : config.boss ? "BOSS M.2 · 2 EA" : "없음";
  const memSummary = `${memoryTotal}GB${config.memory.some((row) => row.qty) ? ` (${config.memory.filter((row) => row.qty).map((row) => `${row.size_gb}GB · ${row.qty} EA`).join(" + ")})` : ""}`;
  const specRows = [
    { key: "cpu", label: "CPU", text: `${config.cpu_model} · ${config.cpu_count} EA`, changed: diff?.spec },
    { key: "mem", label: "MEM", text: memSummary, changed: diff?.spec },
    { key: "disk", label: "Disk", text: diskSummary, changed: false },
    { key: "psu", label: "PSU", text: `${config.psu_watt}W · ${config.psu_count} EA`, changed: diff?.psu },
  ] as const;
  const specBody = (key: "cpu" | "mem" | "disk" | "psu") => {
    if (key === "cpu") return (
      <div className="row">
        <select value={config.cpu_model} onChange={(event) => patch({ cpu_model: event.target.value })} aria-label="CPU 모델">
          {server.cpu_options.map((option) => <option key={option}>{option}</option>)}
        </select>
        × <select value={config.cpu_count} onChange={(event) => patch({ cpu_count: Number(event.target.value) })} aria-label="CPU 수량">
          {Array.from({ length: server.cpu_sockets }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
        </select>
      </div>
    );
    if (key === "mem") return <>
      {config.memory.map((row, index) => (
        <div className="row" key={index}>
          <select value={row.size_gb} onChange={(event) => updateMemory(index, { size_gb: Number(event.target.value) })} aria-label="DIMM 용량">
            {server.memory.dimm_sizes_gb.map((size) => <option key={size} value={size}>{size}GB RDIMM</option>)}
          </select>
          × <input type="number" min="0" max={server.memory.dimm_slots} value={row.qty} style={{ width: 70 }} onChange={(event) => updateMemory(index, { qty: Number(event.target.value) })} aria-label="DIMM 수량" />
          {config.memory.length > 1 && <button className="ico" aria-label="DIMM 행 삭제" onClick={() => patch({ memory: config.memory.filter((_, rowIndex) => rowIndex !== index) })}>✕</button>}
        </div>
      ))}
      <div className="row"><span className="muted">합계 {memoryTotal}GB · DIMM {memoryCount}/{server.memory.dimm_slots}</span><button type="button" className="lnk" onClick={() => patch({ memory: [...config.memory, { size_gb: 64, qty: 0 }] })}>+ 다른 DIMM</button></div>
    </>;
    if (key === "disk") return <>
      <StorageSummary server={server} config={config} bayCount={backplane.bays} />
      <div className="row" role="group" aria-label="Data RAID">
        Data RAID <span className="opts">{RAID_LEVELS.map((level) => (
          <button type="button" key={level || "none"} className="opt" aria-pressed={config.raid.data === level} onClick={() => patch({ raid: { ...config.raid, data: level } })}>{level || "No RAID"}</button>
        ))}</span>
      </div>
      <div className="row">
        Boot RAID <select value={config.raid.boot} onChange={(event) => patch({ raid: { ...config.raid, boot: event.target.value } })} aria-label="Boot RAID">
          {RAID_LEVELS.map((level) => <option key={level} value={level}>{level || "No RAID"}</option>)}
        </select>
        <label><input type="checkbox" checked={config.boss} onChange={(event) => patch({ boss: event.target.checked })} /> BOSS-N1 (M.2 × 2, RAID1 부트)</label>
      </div>
    </>;
    const psuImage = images?.psus?.[String(config.psu_watt)];
    return <>
      <div className="row" role="group" aria-label="PSU 용량">
        <span className="opts">{server.psu_options.map((watt) => (
          <button type="button" key={watt} className="opt" aria-pressed={config.psu_watt === watt} onClick={() => patch({ psu_watt: watt })}>{watt}W</button>
        ))}</span>
        × <select value={config.psu_count} onChange={(event) => patch({ psu_count: Number(event.target.value) })} aria-label="PSU 수량">
          {Array.from({ length: Math.max(1, psuSlots.length) }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
        </select>
        <span className="muted small">같은 용량으로 장착 · 예상 최대 소비전력 {result ? `${Math.round(result.summary.power_est_w)}W` : "-"}</span>
      </div>
      {psuImage && !psuImage.exact && <p className="warn small">{config.psu_watt}W PSU 그림이 라이브러리에 없어 {psuImage.item?.name || "다른 PSU"} 그림에 용량을 표시했습니다.</p>}
    </>;
  };

  // ── 그림 아래 한 줄 요약 ──
  type Warn = { key: string; text: string; title?: string; go?: () => void };
  const frontWarn: Warn[] = [
    ...(result?.bays || []).filter((item) => item.status !== "충족").map((item) => ({
      key: `b${item.bay}`, text: `Bay ${item.bay} ${item.status}`, title: item.issues.map((issue) => issue.msg).join(" / "),
      go: () => { setSelectedSlot(null); setSelectedBays([item.bay]); reveal(frontRef); } })),
    ...(result?.general || []).filter((item) => item.status !== "충족" && DISK_MSG.test(item.msg)).map((item, index) => ({
      key: `g${index}`, text: item.msg, title: item.msg, go: () => openSpec("disk") })),
  ];
  const rearWarn: Warn[] = [
    ...(result?.slots || []).filter((item) => item.component && item.status && item.status !== "충족").map((item) => ({
      key: `s${item.slot}`, text: `${item.label} ${item.status}`, title: item.issues.map((issue) => issue.msg).join(" / "),
      go: () => { setSelectedBays([]); setSelectedSlot(item.slot); reveal(rearRef); } })),
    ...(result?.general || []).filter((item) => item.status !== "충족" && !DISK_MSG.test(item.msg)).map((item, index) => ({
      key: `r${index}`, text: item.msg, title: item.msg, go: PSU_MSG.test(item.msg) ? () => openSpec("psu") : undefined })),
  ];
  const summaryLine = (view: "front" | "rear") => {
    const items = view === "front" ? frontWarn : rearWarn;
    const shown = items.slice(0, 2);
    const pcie = server.slots.filter((slot) => slot.type !== "ocp");
    const ocp = server.slots.filter((slot) => slot.type === "ocp");
    const used = Object.keys(config.bays).length;
    return (
      <div className="sline">
        {view === "front"
          ? <span>{backplane.bays ? <><b>Disk</b> 사용 {used} / 여유 {Math.max(0, backplane.bays - used)}{config.boss ? " · BOSS M.2" : ""}</> : "전면 드라이브 베이 없음"}</span>
          : <span><b>PCIe</b> 사용 {pcie.filter((slot) => config.slots[slot.id]).length} / 여유 {pcie.filter((slot) => !config.slots[slot.id]).length}
            {ocp.length ? ` · OCP ${ocp.some((slot) => config.slots[slot.id]) ? "사용 1" : "비어 있음"}` : ""}
            {result ? ` · 예상 소비전력 ${Math.round(result.summary.power_est_w)}W` : ""}</span>}
        {shown.map((item) => item.go
          ? <button type="button" key={item.key} className="sw" title={item.title} onClick={item.go}>⚠ {item.text}</button>
          : <span key={item.key} className="sw" title={item.title}>⚠ {item.text}</span>)}
        {items.length > shown.length && <span className="muted small">외 {items.length - shown.length}건</span>}
        {!items.length && result && <span className="sok">✓ 이상 없음</span>}
        {notice?.view === view && <span className="warn small" role="status">{notice.text}</span>}
      </div>
    );
  };

  // ── 베이·슬롯 옆 팝오버 ──
  const bayPopover = () => {
    const shared = filledSel.map((index) => config.bays[String(index)]);
    const shownDrive = shared.length && shared.every((bay) => bay.drive === shared[0].drive) ? shared[0].drive : currentDrive;
    const shownRole = shared.length && !emptySel.length && shared.every((bay) => bay.role === shared[0].role) ? shared[0].role : roleChoice;
    const state = !filledSel.length ? "비어 있음"
      : !emptySel.length ? `사용 중${shared.every((bay) => bay.drive === shared[0].drive) ? ` · ${driveShort(shared[0].drive)}` : ""}`
      : `사용 중 ${filledSel.length} · 비어 있음 ${emptySel.length}`;
    const issues = selectedSorted.flatMap((index) => (getBayResult(index)?.issues || []).filter((issue) => issue.status !== "충족").map((issue) => ({ index, ...issue })));
    return <>
      <div className="pop-head"><b>Bay {formatList(selectedSorted)}</b><span className="muted small">{state}</span><button type="button" className="ico" aria-label="닫기" onClick={clearSelection}>✕</button></div>
      {need && <div className="pop-need">필요: {need}</div>}
      <select aria-label="디스크 종류" value={shownDrive} onChange={(event) => { setDiskChoice(event.target.value); changeFilled({ drive: event.target.value }); }}>
        {driveOptions.map((drive) => <option key={drive.id} value={drive.id}>{drive.name}</option>)}
      </select>
      <div className="row">
        <span role="group" aria-label="용도" className="opts">
          {(["data", "boot"] as const).map((role) => (
            <button type="button" key={role} className="opt" aria-pressed={shownRole === role} onClick={() => { setRoleChoice(role); changeFilled({ role }); }}>{role === "data" ? "Data" : "Boot"}</button>
          ))}
        </span>
        <button type="button" className="btn small" disabled={!emptySel.length || !currentDrive} onClick={installSelected}>꽂기{emptySel.length > 1 ? ` ${emptySel.length}개` : ""}</button>
        <button type="button" className="btn small danger" disabled={!filledSel.length} onClick={removeBays}>빼기{filledSel.length > 1 ? ` ${filledSel.length}개` : ""}</button>
      </div>
      {issues.length > 0 && <ul className="issues">{issues.map((issue, index) => <li key={index}><StatusBadge status={issue.status} /> Bay {issue.index} — {issue.msg}</li>)}</ul>}
      <p className="muted small pop-tip">Shift+클릭·드래그로 여러 칸</p>
    </>;
  };
  const slotPopover = () => {
    if (!selectedSlot) return null;
    const close = <button type="button" className="ico" aria-label="닫기" onClick={clearSelection}>✕</button>;
    if (selectedPsu >= 0) {
      const filled = selectedPsu < config.psu_count;
      return <>
        <div className="pop-head"><b>{psuSlots[selectedPsu].label}</b><span className="muted small">{filled ? `${config.psu_watt}W 장착` : "비어 있음"} · PSU {config.psu_count}/{psuSlots.length}개</span>{close}</div>
        {need && <div className="pop-need">필요: {need}</div>}
        <div className="row">
          <span className="opts" role="group" aria-label="PSU 용량">
            {server.psu_options.map((watt) => (
              <button type="button" key={watt} className="opt" aria-pressed={filled && config.psu_watt === watt}
                onClick={() => patch({ psu_watt: watt, psu_count: Math.max(config.psu_count, selectedPsu + 1) })}>{watt}W</button>
            ))}
          </span>
          <button type="button" className="btn small danger" disabled={!filled} onClick={() => patch({ psu_count: selectedPsu })}>빼기</button>
        </div>
        <p className="muted small pop-tip">같은 용량으로 장착합니다 (바꾸면 모두 바뀜)</p>
        {psuWarn && <ul className="issues">{result?.general.filter((item) => item.status !== "충족" && PSU_MSG.test(item.msg)).map((item, i) => <li key={i}><StatusBadge status={item.status} /> {item.msg}</li>)}</ul>}
      </>;
    }
    const slot = server.slots.find((item) => item.id === selectedSlot);
    if (!slot) return null;
    const slotResult = getSlotResult(slot.id);
    const fits = components.filter((item) => slot.type === "ocp" ? item.form === "ocp" : item.form !== "ocp");
    const riser = slot.riser ? server.risers.find((item) => item.id === slot.riser) : undefined;
    const riserOn = !!slot.riser && config.risers.includes(slot.riser);
    const setPart = (id: string) => {
      const slots = { ...config.slots };
      if (id) slots[slot.id] = id;
      else delete slots[slot.id];
      patch({ slots });
    };
    return <>
      <div className="pop-head"><b>{slot.label}</b><span className="muted small">{slot.type === "ocp" ? `OCP 3.0 SFF x${slot.lanes}` : `PCIe Gen${slot.gen} x${slot.lanes} · ${slot.height}${slot.double_width_ok ? " · 더블 폭" : ""}`} · CPU{slot.cpu}</span>{close}</div>
      {need && <div className="pop-need">필요: {need}</div>}
      <select aria-label={`${slot.label} 장착 부품`} value={config.slots[slot.id] || ""} onChange={(event) => setPart(event.target.value)}>
        <option value="">(비움)</option>
        {fits.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
      </select>
      <div className="row">
        {slot.riser && (
          <span className="opts" role="group" aria-label={`${riser?.name || slot.riser} 장착`}>
            <button type="button" className="opt" aria-pressed={riserOn} onClick={() => { if (!riserOn) patch({ risers: [...config.risers, slot.riser as string] }); }}>{riser?.name || slot.riser} 장착</button>
            <button type="button" className="opt" aria-pressed={!riserOn} onClick={() => { if (riserOn) patch({ risers: config.risers.filter((id) => id !== slot.riser) }); }}>없음</button>
          </span>
        )}
        <button type="button" className="btn small danger" disabled={!config.slots[slot.id]} onClick={() => setPart("")}>빼기</button>
        {slotResult?.status && <StatusBadge status={slotResult.status} />}
      </div>
      {slotResult && !slotResult.usable && <p className="warn small">지금은 사용 불가 ({slot.cpu > config.cpu_count ? `CPU ${slot.cpu}개 필요` : "Riser 필요"})</p>}
      {!!slotResult?.issues.length && <ul className="issues">{slotResult.issues.map((issue, index) => <li key={index}><StatusBadge status={issue.status} /> {issue.msg}</li>)}</ul>}
    </>;
  };
  const popoverRect = (view: "front" | "rear"): Rect | null => {
    if (view === "rear") return selectedSlot ? rearSpot(selectedSlot) || null : null;
    const rects = selectedBays.map((index) => currentFrontRects[index]).filter(Boolean);
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  };
  /** floating: 그림 위 선택한 칸 옆에 띄움 / 아니면(그림이 없거나 칸 위치를 모를 때) 그림 아래에 그대로 */
  const renderPopover = (view: "front" | "rear", floating: boolean) => {
    if (zoom || mode !== "edit" || (view === "front" ? !selectedBays.length : !selectedSlot)) return null;
    const body = view === "front" ? bayPopover() : slotPopover();
    if (!body) return null;
    const rect = popoverRect(view);
    if (!floating || !rect) return <div className="pop static" role="dialog" aria-label={view === "front" ? "디스크 선택" : "슬롯 선택"}>{body}</div>;
    const cx = rect.x + rect.w / 2;
    const below = rect.y + rect.h / 2 < 60;
    const style = { left: `clamp(150px, ${cx}%, calc(100% - 150px))`,
      ...(below ? { top: `calc(${rect.y + rect.h}% + 8px)` } : { bottom: `calc(${100 - rect.y}% + 8px)` }) };
    return <div className="pop" style={style} role="dialog" aria-label={view === "front" ? "디스크 선택" : "슬롯 선택"} onPointerDown={(event) => event.stopPropagation()}>{body}</div>;
  };

  const renderStage = (view: "front" | "rear", big = false) => {
    const info = images?.[view];
    const rendered = renderedImages[view] || info?.item?.url || null;
    const floatOk = !big && !zoom && !!rendered && !!popoverRect(view);
    const areas = view === "front"
      ? currentFrontRects.map((area, index) => ({ area, slot: undefined, index }))
      : [...server.slots, ...psuSlots].flatMap((slot, index) => rearSpot(slot.id) ? [{ area: rearSpot(slot.id) as Rect, slot, index }] : []);
    return (
      <figure className="stage" key={view} ref={view === "front" ? frontRef : rearRef}>
        <figcaption><b>{view === "front" ? "Front" : "Rear"}</b><span className="muted">{info?.item?.name || "실제 이미지 미지정"}</span>
          {rendered && !big && <button type="button" className="zoombtn" aria-label={`${view === "front" ? "전면" : "후면"} 크게 보기`} data-tip="크게 보기" onClick={() => { setZoom(view); }}>⤢</button>}</figcaption>
        {mode === "calib" && rendered && (
          <div className="ptools" role="toolbar" aria-label={view === "front" ? "전면 보정 도구" : "후면 보정 도구"}>
            {view === "front" ? <>
              <button type="button" data-tip="베이 자동 감지 다시" aria-label="베이 자동 감지 다시" disabled={calibrationBusy} onClick={() => void redetect()}>↻</button>
              <button type="button" data-tip="Bay 0 크기를 전체에 적용" aria-label="Bay 0 크기를 전체에 적용" className="txt" onClick={copyFirstSize}>ALL</button>
              <button type="button" data-tip="처음·끝 사이 균등 배치 — Bay 0과 마지막 베이만 맞추고 누르세요" aria-label="처음·끝 사이 균등 배치" onClick={distributeBays}>⇔</button>
              {imageBayMismatch && <>
                <i aria-hidden="true" />
                <button type="button" data-tip={`왼쪽부터 ${backplane.bays}개 사용`} aria-label={`왼쪽부터 ${backplane.bays}개 사용`} onClick={() => useCandidates("start")}>◧</button>
                <button type="button" data-tip={`오른쪽부터 ${backplane.bays}개 사용`} aria-label={`오른쪽부터 ${backplane.bays}개 사용`} onClick={() => useCandidates("end")}>◨</button>
              </>}
            </> : (
              <button type="button" data-tip="가림 영역 추가 — 이 모델로 쓸 수 없는 자리를 검정 박스로 가립니다" aria-label="가림 영역 추가" onClick={() => {
                const used = Object.keys(slotHotspots).filter((key) => key.startsWith("blk:")).map((key) => Number(key.slice(4)));
                const next = used.length ? Math.max(...used) + 1 : 0;
                setSlotHotspots((current) => ({ ...current, [`blk:${next}`]: { x: 42, y: 40, w: 14, h: 22, reason: BLOCK_REASON } }));
              }}>⊘</button>
            )}
          </div>
        )}
        {rendered ? (
          <div className={`chassis mode-${mode}`}>
            <img src={rendered} alt={`${server.vendor} ${server.model} ${view === "front" ? "전면" : "후면"}`} />
            <div className="hot" onClick={(event) => {
              if (dragged.current) { dragged.current = false; return; }
              if (mode === "edit" && event.target === event.currentTarget) clearSelection();
            }} onPointerDown={(event) => startDrag(view, event)} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
              {areas.map(({ area, slot, index }) => {
                if (view === "front") {
                  const bay = config.bays[String(index)];
                  const status = getBayResult(index)?.status;
                  const issue = getBayResult(index)?.issues.map((item) => item.msg).join(" / ");
                  const { padL, padR } = bayPads[index] || { padL: 0, padR: 0 };
                  const width = area.w + padL + padR;
                  const before = renderedImages.config?.backplane === config.backplane ? renderedImages.config.bays[String(index)] : undefined;
                  const preview = !renderedImages.config || renderedImages.config.backplane !== config.backplane ? null
                    : bay && (!before || before.drive !== bay.drive) ? "in" : !bay && before ? "out" : null;
                  const name = bay ? server.drive_options.find((drive) => drive.id === bay.drive)?.name || bay.drive : "";
                  return (
                    <button
                      key={`bay-${index}`}
                      className={`bay ${bay ? "filled" : ""} ${area.w < 2.6 ? "narrow" : ""} ${selectedBays.includes(index) ? "sel" : ""} ${mode === "calib" && calibSel?.view === "front" && calibSel.key === String(index) ? "csel" : ""} ${diff?.bays.has(index) ? "diff" : ""}`}
                      type="button"
                      aria-label={`Bay ${index}${bay ? ` · ${name} · ${bay.role === "boot" ? "Boot" : "Data"}` : " · 비어 있음"}`}
                      aria-pressed={mode === "edit" ? selectedBays.includes(index) : undefined}
                      data-calib-key={String(index)}
                      data-tip={mode === "edit" ? `Bay ${index} · ${bay ? `${name} · ${bay.role === "boot" ? "Boot" : "Data"}` : "비어 있음"}${diff?.bays.has(index) ? " · 견적 대비 변경" : ""}${issue ? ` — ${issue}` : ""}` : undefined}
                      style={{ left: `${area.x - padL}%`, top: `${area.y}%`, width: `${width}%`, height: `${area.h}%` }}
                      onPointerDown={(event) => {
                        if (mode !== "edit" || event.button !== 0) return;
                        event.preventDefault();
                        pressBay(index, event);
                      }}
                      onPointerEnter={(event) => { if (mode === "edit" && event.buttons & 1) dragOverBay(index); }}
                      onClick={(event) => { if (mode === "edit" && event.detail === 0) pressBay(index, event); }}
                    >
                      <span className="bx" style={{ left: `${padL / width * 100}%`, width: `${area.w / width * 100}%` }}>
                        {preview && <span className={`pv ${preview} ${bay?.role === "boot" ? "boot" : ""}`} />}
                      </span>
                      <span className="bn">{index}</span>
                      {(status === "호환 불가" || status === "확인 필요") && <span className={`warnb ${status === "호환 불가" ? "bad" : ""}`} aria-hidden="true">!</span>}
                      {mode === "calib" && <span className="grip" />}
                      {mode === "calib" && (
                        <span
                          className="bay-x"
                          role="button"
                          aria-label={`Bay ${index} 빼기`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setFrontRects(currentFrontRects.filter((_, rectIndex) => rectIndex !== index));
                          }}
                        >✕</span>
                      )}
                    </button>
                  );
                }
                if (!slot) return null;
                const isPsu = slot.type === "psu";
                const psuFilled = isPsu && psuIndex(slot.id) < config.psu_count;
                const slotResult = getSlotResult(slot.id);
                const off = !isPsu && slotResult?.usable === false;
                const status = isPsu ? (psuFilled && psuWarn ? "확인 필요" : null) : slotResult?.status;
                const part = isPsu ? (psuFilled ? `${config.psu_watt}W` : "비어 있음")
                  : components.find((item) => item.id === config.slots[slot.id])?.name || (config.slots[slot.id] ? config.slots[slot.id] : "비어 있음");
                const tip = off ? unusableReason(slot)
                  : `${slot.label} · ${part}${slotResult?.issues.length ? ` — ${slotResult.issues.map((item) => item.msg).join(" / ")}` : ""}`;
                return (
                  <button
                    key={slot.id}
                    className={`hs ${isPsu ? `psu ${psuFilled ? "" : "empty"}` : ""} ${off ? "s-off" : ""} ${selectedSlot === slot.id ? "sel" : ""} ${mode === "calib" && calibSel?.view === "rear" && calibSel.key === slot.id ? "csel" : ""} ${(isPsu ? diff?.psu : diff?.slots.has(slot.id)) ? "diff" : ""}`}
                    type="button"
                    aria-label={`${slot.label} · ${off ? "사용 불가" : part}`}
                    aria-pressed={mode === "edit" ? selectedSlot === slot.id : undefined}
                    data-calib-key={slot.id}
                    data-tip={mode === "edit" ? `${tip}${(isPsu ? diff?.psu : diff?.slots.has(slot.id)) ? " · 견적 대비 변경" : ""}` : undefined}
                    style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%` }}
                    onClick={() => {
                      if (mode !== "edit") return;
                      setSelectedBays([]);
                      setSelectedSlot((current) => current === slot.id ? null : slot.id);
                    }}
                  >
                    <span className="tag">{slot.label}</span>
                    {(status === "호환 불가" || status === "확인 필요") && <span className={`warnb ${status === "호환 불가" ? "bad" : ""}`} aria-hidden="true">!</span>}
                    {mode === "calib" && <span className="grip" />}
                  </button>
                );
              })}
              {view === "rear" && Object.entries(slotHotspots).filter(([key]) => key.startsWith("blk:")).map(([key, area]) => (
                <div
                  key={key}
                  className={`hs blocked ${mode === "calib" && calibSel?.view === "rear" && calibSel.key === key ? "csel" : ""}`}
                  data-calib-key={key}
                  data-tip={area.reason || BLOCK_REASON}
                  aria-label={`사용할 수 없는 영역: ${area.reason || BLOCK_REASON}`}
                  style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%` }}
                >
                  <span className="blk-ico" aria-hidden="true">⊘</span>
                  {mode === "calib" && <span className="grip" />}
                  {mode === "calib" && (
                    <span className="bay-x" role="button" aria-label="가림 영역 삭제"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSlotHotspots((current) => Object.fromEntries(Object.entries(current).filter(([other]) => other !== key)));
                      }}>✕</span>
                  )}
                </div>
              ))}
              {view === "front" && mode === "calib" && freeCandidates.map((area, index) => (
                <button
                  key={`cand-${index}`}
                  type="button"
                  className="bay cand"
                  title="이미지에서 찾은 베이 — 클릭하면 사용할 베이로 추가"
                  style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%` }}
                  onClick={() => {
                    if (currentFrontRects.length >= backplane.bays) {
                      setCalibrationMessage(`백플레인은 ${backplane.bays}베이입니다. 먼저 사용 중인 베이의 ✕로 하나를 빼세요.`);
                      return;
                    }
                    setFrontRects(sortRects([...currentFrontRects, area]));
                    setCalibrationMessage("");
                  }}
                >+</button>
              ))}
            </div>
            {floatOk && renderPopover(view, true)}
          </div>
        ) : (
          <div className="noimg">
            {view === "front" && backplane.bays === 0 ? <>
              <p><strong>{backplane.name} — 전면 드라이브 베이가 없는 구성입니다.</strong></p>
              <p className="muted">부트 디스크는 BOSS(M.2)로 구성합니다. 디스크가 필요하면 모델 옆 "변경"에서 백플레인을 바꾸세요.</p>
            </> : <>
            <p><strong>{server.model} {view === "front" ? "전면" : "후면"} 실제 이미지가 없습니다.</strong></p>
            <p>Dell PowerEdge 스텐실(VSSX/VSDX)이나 이미지를 올려 주세요. 올리면 이 모델에 자동으로 연결됩니다.</p>
            <p><button type="button" className="btn small" onClick={onOpenImages}>실제 이미지 올리기</button></p>
            <p className="muted">{view === "front" ? "그림이 없어도 오른쪽 위 ⋯ → 디스크 일괄 작업에서 디스크를 꽂고 검증할 수 있습니다." : "그림이 없어도 오른쪽 위 ⋯ → 슬롯 목록에서 부품을 꽂고 검증할 수 있습니다."}</p>
            </>}
          </div>
        )}
        {!floatOk && !big && renderPopover(view, false)}
      </figure>
    );
  };

  const calibBar = mode === "calib" ? (
    <div className="calibbar" role="toolbar" aria-label="좌표 보정">
      <b>좌표 보정 중</b>
      <span className="muted">영역을 끌어 옮기고, 오른쪽 아래 모서리로 크기 조절 · 방향키 0.1%(Shift 1%) · Alt+방향키 크기 · 베이 {currentFrontRects.length}/{backplane.bays}</span>
      <span className="calibbar-act">
        <button type="button" className="btn ghost small" disabled={calibrationBusy} onClick={() => {
          setFrontRects(images?.bays.rects || []);
          setSlotHotspots(savedHotspots(server));
          setMode("edit");
          setCalibrationMessage("");
        }}>취소</button>
        <button type="button" className="btn small" disabled={calibrationBusy} onClick={() => void saveCalibration()}>저장하고 끝내기</button>
      </span>
    </div>
  ) : null;
  const calibMessage = calibrationMessage ? <p className={calibrationMessage.includes("오류") ? "warn small" : "muted small"} role={calibrationMessage.includes("오류") ? "alert" : "status"}>{calibrationMessage}</p> : null;
  const zoomPanel = () => {
    if (mode === "calib") {
      const cur = calibSel ? (calibSel.view === "front" ? currentFrontRects[Number(calibSel.key)] : slotHotspots[calibSel.key]) : null;
      return <>
        <p><b>좌표 보정</b></p>
        {cur && calibSel
          ? <p className="small">{calibSel.view === "front" ? `Bay ${calibSel.key}` : calibSel.key}<br />x {cur.x.toFixed(1)}% · y {cur.y.toFixed(1)}%<br />폭 {cur.w.toFixed(1)}% · 높이 {cur.h.toFixed(1)}%</p>
          : <p className="muted small">영역을 눌러 고르세요.</p>}
        <p className="muted small">방향키: 위치 0.1% · Shift 1%<br />Alt+방향키: 크기<br />끌어서 옮기거나 모서리로 크기 조절도 가능합니다. 저장은 위의 '저장하고 끝내기'를 눌러야 반영됩니다.</p>
      </>;
    }
    const has = zoom === "front" ? selectedBays.length > 0 : !!selectedSlot;
    return <>
      {has ? (zoom === "front" ? bayPopover() : slotPopover()) : <p className="muted small">{zoom === "front" ? "베이를 클릭해 고르세요." : "슬롯이나 PSU를 클릭해 고르세요."}</p>}
      <p className="muted small zoomkeys">방향키: 선택 이동{zoom === "front" ? " · Shift+방향키: 선택 확장 · Shift+클릭/드래그: 여러 칸" : ""}<br />Esc: 닫기 (장착·제거는 바로 반영됩니다)</p>
    </>;
  };

  return (
    <>
      <section id="s3" className="card cfg">
        <div className="cardhead">
          {modelLine}
          <div className="tools">
            <button type="button" className="lnk dots" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="고급 도구" onClick={() => setMenuOpen(!menuOpen)}>⋯</button>
            {menuOpen && (
              <div className="menu" role="menu" onClick={() => setMenuOpen(false)}>
                <button role="menuitem" onClick={onOpenImages}>서버 이미지 변경</button>
                <button role="menuitem" onClick={() => setShowSlotList(!showSlotList)}>{showSlotList ? "슬롯 목록 숨기기" : "슬롯 목록으로 보기"}</button>
                <button role="menuitem" disabled={!backplane.bays} onClick={() => { setSelectedSlot(null); setSelectedBays(Array.from({ length: backplane.bays }, (_, i) => i).filter((i) => !config.bays[String(i)])); }}>빈 베이 모두 선택</button>
                <button role="menuitem" disabled={!backplane.bays} onClick={() => { setSelectedSlot(null); setSelectedBays(Array.from({ length: backplane.bays }, (_, i) => i)); }}>베이 전체 선택</button>
                <button role="menuitem" disabled={!Object.keys(config.bays).length} onClick={() => patch({ bays: {} })}>디스크 전체 빼기</button>
                <hr />
                <button role="menuitem" onClick={() => setMode("calib")}>좌표 보정</button>
              </div>
            )}
          </div>
        </div>
        <div className="cardbody">
          {quotePanel}
          <div className="specrows" ref={specRef}>
            {specRows.map((row) => (
              <div key={row.key} className={`sr ${specOpen === row.key ? "on" : ""}`}>
                <button type="button" className="sr-h" aria-expanded={specOpen === row.key} onClick={() => setSpecOpen(specOpen === row.key ? null : row.key)}>
                  <b>{row.label}</b><span>{row.text}</span>{row.changed ? <i className="l-diff" /> : null}<span className="lnk">{specOpen === row.key ? "닫기" : "바꾸기"}</span>
                </button>
                {specOpen === row.key && <div className="sr-b">{specBody(row.key)}</div>}
              </div>
            ))}
          </div>
        {!zoom && calibBar}
        {!zoom && calibMessage}
        {imageBayMismatch && mode !== "calib" && candidates.length < backplane.bays && (
          <div className="hint">
            이 전면 이미지에는 베이가 {candidates.length}개뿐이라 {backplane.name} 구성을 모두 표시할 수 없습니다.
            {" "}{images?.front.auto === false
              ? <button className="btn small" onClick={() => void onUseAutoFront()}>자동 이미지로 되돌리기</button>
              : <button className="btn ghost small" onClick={onOpenImages}>다른 이미지 고르기</button>}
          </div>
        )}
        {imageBayMismatch && mode !== "calib" && candidates.length > backplane.bays && (
          <div className="hint">
            전면 이미지에는 베이가 {candidates.length}개 보이는데 선택한 백플레인은 {backplane.bays}베이입니다.
            {matchingBackplane && <> <button className="btn small" onClick={() => onBackplaneChange(matchingBackplane.id)}>백플레인을 {matchingBackplane.name}(으)로 변경</button></>}
            {" "}<button className="btn ghost small" onClick={() => setMode("calib")}>사용할 베이 고르기</button>
          </div>
        )}
        {renderStage("front")}
        {summaryLine("front")}
        {renderStage("rear")}
        {summaryLine("rear")}
        {showSlotList && <details className="sub" open>
          <summary>슬롯 목록</summary>
          <div className="scroll">
            <table className="grid">
              <thead><tr><th>슬롯</th><th>사양</th><th>CPU</th><th>Riser</th><th>장착 부품</th><th>상태</th></tr></thead>
              <tbody>{server.slots.map((slot) => {
                const slotResult = getSlotResult(slot.id);
                return (
                  <tr key={slot.id}>
                    <td><b>{slot.label}</b></td>
                    <td>{slot.type === "ocp" ? `OCP 3.0 SFF x${slot.lanes}` : `Gen${slot.gen} x${slot.lanes} ${slot.height}${slot.double_width_ok ? " · DW" : ""}`}</td>
                    <td>CPU{slot.cpu}</td><td>{slot.riser || "-"}</td>
                    <td>
                      <select id={`slot-${slot.id}`} value={config.slots[slot.id] || ""} onChange={(event) => {
                        const slots = { ...config.slots };
                        if (event.target.value) slots[slot.id] = event.target.value;
                        else delete slots[slot.id];
                        patch({ slots });
                      }}>
                        <option value="">(비움)</option>
                        {components.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
                      </select>
                    </td>
                    <td>{slotResult?.status ? <StatusBadge status={slotResult.status} /> : <span className="muted">{slotResult && !slotResult.usable ? "사용 불가(CPU/Riser)" : "빈 슬롯"}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </details>}

        </div>
      </section>
      {zoom && (
        <div className="zoombk" role="dialog" aria-modal="true" aria-label={`${zoom === "front" ? "전면" : "후면"} 크게 보기`}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setZoom(null); }}>
          <div className="zoombox">
            <div className="zoomhead">
              <b>{zoom === "front" ? "Front" : "Rear"}</b><span className="muted small">{server.vendor} {server.model}</span>
              <span className="opts" role="group" aria-label="그림 배율">
                <button type="button" className="opt" aria-label="축소" disabled={scale <= 1} onClick={() => setScale((v) => Math.max(1, v - 0.25))}>−</button>
                <button type="button" className="opt" aria-label="배율 100%" onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
                <button type="button" className="opt" aria-label="확대" disabled={scale >= 5} onClick={() => setScale((v) => Math.min(5, v + 0.25))}>+</button>
              </span>
              <span className="muted small">Ctrl + / − / 0 · Ctrl+휠</span>
              <span className="opts" role="group" aria-label="작업 종류">
                <button type="button" className="opt" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>구성</button>
                <button type="button" className="opt" aria-pressed={mode === "calib"} onClick={() => setMode("calib")}>좌표 보정</button>
              </span>
              <button type="button" className="ico zoomx" autoFocus aria-label="닫기" onClick={() => setZoom(null)}>✕</button>
            </div>
            {calibBar}
            {calibMessage}
            <div className="zoomgrid">
              <div className="zoomstage"><div className="zoomscale" style={{ width: `${scale * 100}%` }}>{renderStage(zoom, true)}</div></div>
              <aside className="zoompanel" aria-label="선택한 항목">{zoomPanel()}</aside>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** [0,1,2,3,7] → "0–3, 7" */
function formatList(items: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    let j = i;
    while (j + 1 < items.length && items[j + 1] === items[j] + 1) j++;
    parts.push(j - i >= 2 ? `${items[i]}–${items[j]}` : items.slice(i, j + 1).join(", "));
    i = j;
  }
  return parts.join(", ");
}

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = { "충족": "ok", "미충족": "fail", "호환 불가": "incomp", "확인 필요": "review" };
  return <em className={`st st-${classes[status] || "review"}`}>{status}</em>;
}

function StorageSummary({ server, config, bayCount }: { server: Server; config: ServerConfig; bayCount: number }) {
  const used = Object.keys(config.bays).length;
  const roles = (["boot", "data"] as const).flatMap((role) => {
    const drives = Object.values(config.bays).filter((bay) => bay.role === role);
    if (!drives.length) return [];
    const counts = new Map<string, number>();
    drives.forEach(({ drive }) => counts.set(drive, (counts.get(drive) || 0) + 1));
    const names = [...counts].map(([id, count]) => ({ name: server.drive_options.find((item) => item.id === id)?.name || id, count }));
    const sizes = names.flatMap(({ name, count }) => Array<number>(count).fill(driveGb(name)));
    // 한 RAID 묶음 안에서 용량이 다르면 가장 작은 디스크 기준으로 잡힌다
    const smallest = Math.min(...sizes);
    const level = config.raid[role];
    return [{ role, names, raw: sizes.reduce((total, size) => total + size, 0), level,
      usable: usableGb(level, drives.length, smallest), mixed: counts.size > 1, count: drives.length }];
  });
  return (
    <div className="storage">
      <span className="muted">전면 베이 {used}/{bayCount} 사용 · 빈 베이 {Math.max(0, bayCount - used)}개{config.boss ? " · BOSS-N1 M.2 부트(RAID1)" : ""}</span>
      {roles.map((row) => (
        <span key={row.role} className={`chip ${row.usable === null || row.mixed ? "chip-bad" : ""}`}>
          <b>{row.role === "boot" ? "Boot" : "Data"}</b> {row.names.map(({ name, count }) => `${name} · ${count} EA`).join(" + ")} · {row.level || "No RAID"} · 원시 {formatGb(row.raw)}
          {row.usable === null ? ` · ${row.level}에 디스크 ${row.count}개는 구성 불가` : ` · 사용 가능 약 ${formatGb(row.usable)}`}
          {row.mixed && " · 서로 다른 디스크 혼용"}
        </span>
      ))}
    </div>
  );
}
