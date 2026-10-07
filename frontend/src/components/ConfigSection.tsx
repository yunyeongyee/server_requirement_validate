import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import type { Component, ImageStatus, Server, ServerConfig, ValidationResult } from "../types";

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
  /** 직접 고른 전면 이미지를 해제해 자동(스텐실 또는 기본 도면)으로 */
  onUseAutoFront: () => Promise<void>;
}

/** 서버가 합성한 전면/후면 그림과, 그 그림을 만든 구성 (화면 미리보기와 비교용) */
export interface RenderedImages {
  front: string | null;
  rear: string | null;
  config?: ServerConfig;
}

export interface FocusRequest {
  kind: "slot" | "spec" | "bays";
  part?: "fc" | "nic" | "gpu" | "psu";
  n: number;
}

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
}: Props) {
  const [imageView, setImageView] = useState<"both" | "front" | "rear">("both");
  const [mode, setMode] = useState<"edit" | "clean" | "calib">("edit");
  const [selectedBays, setSelectedBays] = useState<number[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showSlotList, setShowSlotList] = useState(false);
  /** 펼침 설정: RAID·BOSS(전면 막대 아래) / CPU·메모리(내부 줄 아래) */
  const [panel, setPanel] = useState<"raid" | "spec" | null>(null);
  /** 작업 막대에서 고른 꽂을 디스크 종류·용도 (마지막에 고른 값 유지) */
  const [diskChoice, setDiskChoice] = useState("");
  const [roleChoice, setRoleChoice] = useState<"data" | "boot">("data");
  const slotPanelRef = useRef<HTMLDivElement>(null);
  const frontBarRef = useRef<HTMLDivElement>(null);
  const rearBarRef = useRef<HTMLDivElement>(null);
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
  function openPanel(next: "raid" | "spec") {
    setPanel(next);
    reveal(next === "spec" ? slotPanelRef : frontBarRef);
  }
  const clearSelection = () => {
    setSelectedBays([]);
    setSelectedSlot(null);
    anchorBay.current = null;
  };
  // 모델·백플레인이 바뀌면 이전 선택은 의미가 없다
  useEffect(() => { clearSelection(); }, [server?.id, config?.backplane]);
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

  useEffect(() => {
    if (!focus || !server) return;
    if (focus.kind === "bays") {
      // 디스크 추가 요청: 빈 베이를 모두 골라 두고 '꽂기'만 누르면 되게
      const total = server.backplanes.find((item) => item.id === config?.backplane)?.bays || 0;
      setSelectedSlot(null);
      setSelectedBays(Array.from({ length: total }, (_, index) => index).filter((index) => !config?.bays[String(index)]));
      reveal(frontBarRef);
    } else if (focus.kind === "spec") {
      openPanel("spec");
    } else if (focus.kind === "slot" && focus.part === "psu") {
      const psuSlots = server.psu_slots || [];
      const target = psuSlots[Math.min(config?.psu_count || 0, psuSlots.length - 1)];
      if (target) {
        setSelectedBays([]);
        setSelectedSlot(target.id);
        reveal(rearBarRef);
      } else {
        openPanel("spec");
      }
    } else if (focus.kind === "slot") {
      const free = server.slots.find((slot) => slot.type !== "ocp" && !config?.slots[slot.id]
        && (result?.slots.find((item) => item.slot === slot.id)?.usable ?? true));
      if (free) {
        setSelectedBays([]);
        setSelectedSlot(free.id);
        reveal(rearBarRef);
      }
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
  // 후면이 기본 도면이면 도면이 정한 위치를, 실제 이미지면 저장된(보정한) 좌표를 쓴다
  const rearLayout = images?.rear.schematic ? images.rear.layout || null : null;
  const rearSpot = (id: string): Rect | undefined => rearLayout ? rearLayout[id] : slotHotspots[id];
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

  const renderStage = (view: "front" | "rear") => {
    const info = images?.[view];
    const rendered = renderedImages[view] || info?.item?.url || null;
    const isVisible = imageView === "both" || imageView === view;
    const areas = view === "front"
      ? currentFrontRects.map((area, index) => ({ area, slot: undefined, index }))
      : [...server.slots, ...psuSlots].flatMap((slot, index) => rearSpot(slot.id) ? [{ area: rearSpot(slot.id) as Rect, slot, index }] : []);
    return (
      <figure className="stage" key={view} hidden={!isVisible}>
        <figcaption><b>{view === "front" ? "Front" : "Rear"}</b><span className="muted">{info?.item?.name || "실제 이미지 미지정"}</span></figcaption>
        {mode === "calib" && rendered && !(view === "rear" && rearLayout) && (
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
                      className={`bay ${bay ? "filled" : ""} ${area.w < 2.6 ? "narrow" : ""} ${selectedBays.includes(index) ? "sel" : ""}`}
                      type="button"
                      aria-label={`Bay ${index}${bay ? ` · ${name} · ${bay.role === "boot" ? "Boot" : "Data"}` : " · 비어 있음"}`}
                      aria-pressed={mode === "edit" ? selectedBays.includes(index) : undefined}
                      data-calib-key={String(index)}
                      data-tip={mode === "edit" ? `Bay ${index} · ${bay ? `${name} · ${bay.role === "boot" ? "Boot" : "Data"}` : "비어 있음"}${issue ? ` — ${issue}` : ""}` : undefined}
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
                    className={`hs ${isPsu ? `psu ${psuFilled ? "" : "empty"}` : ""} ${off ? "s-off" : ""} ${selectedSlot === slot.id ? "sel" : ""}`}
                    type="button"
                    aria-label={`${slot.label} · ${off ? "사용 불가" : part}`}
                    aria-pressed={mode === "edit" ? selectedSlot === slot.id : undefined}
                    data-calib-key={rearLayout ? undefined : slot.id}
                    data-tip={mode === "edit" ? tip : undefined}
                    style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%` }}
                    onClick={() => {
                      if (mode !== "edit") return;
                      setSelectedBays([]);
                      setSelectedSlot((current) => current === slot.id ? null : slot.id);
                    }}
                  >
                    <span className="tag">{slot.label}</span>
                    {(status === "호환 불가" || status === "확인 필요") && <span className={`warnb ${status === "호환 불가" ? "bad" : ""}`} aria-hidden="true">!</span>}
                    {mode === "calib" && !rearLayout && <span className="grip" />}
                  </button>
                );
              })}
              {view === "rear" && !rearLayout && Object.entries(slotHotspots).filter(([key]) => key.startsWith("blk:")).map(([key, area]) => (
                <div
                  key={key}
                  className="hs blocked"
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
          </div>
        ) : (
          <div className="noimg">
            {view === "front" && backplane.bays === 0 ? <>
              <p><strong>{backplane.name} — 전면 드라이브 베이가 없는 구성입니다.</strong></p>
              <p className="muted">부트 디스크는 BOSS(M.2)로 구성합니다. 디스크가 필요하면 모델 옆 "변경"에서 백플레인을 바꾸세요.</p>
            </> : <>
            <p><strong>{server.model} {view === "front" ? "전면" : "후면"} 실제 이미지가 없습니다.</strong></p>
            <p>2단계에서 Dell PowerEdge Rack Servers 스텐실(VSSX) 또는 VSDX를 올리면 자동으로 연결됩니다.</p>
            <p className="muted">이미지가 없어도 구성 목록에서 부품 및 디스크를 지정하고 검증할 수 있습니다.</p>
            </>}
          </div>
        )}
      </figure>
    );
  };

  return (
    <>
      <section id="s3" className="card cfg">
        <div className="cardhead">
          {modelLine}
          <div className="tools">
            {mode === "clean" && <span className="tag">제안서 보기 <button type="button" className="lnk" onClick={() => setMode("edit")}>끝내기</button></span>}
            <button type="button" className="lnk" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>⋯ 도구</button>
            {toolsOpen && (
              <div className="menu" role="menu" onClick={() => setToolsOpen(false)}>
                <button role="menuitem" onClick={onOpenImages}>서버 이미지 변경</button>
                <button role="menuitem" onClick={() => setMode("calib")}>좌표 보정</button>
                <button role="menuitem" onClick={() => setMode(mode === "clean" ? "edit" : "clean")}>{mode === "clean" ? "편집 화면으로" : "제안서 보기 (표시 없이)"}</button>
                <button role="menuitem" onClick={() => setShowSlotList(!showSlotList)}>{showSlotList ? "슬롯 목록 숨기기" : "슬롯 목록으로 보기"}</button>
                <hr />
                {(["both", "front", "rear"] as const).map((view) => (
                  <button role="menuitemradio" aria-checked={imageView === view} key={view} onClick={() => setImageView(view)}>
                    {imageView === view ? "✓ " : ""}{view === "both" ? "전면 + 후면" : view === "front" ? "전면만" : "후면만"}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="cardbody">
          <button type="button" className={`specline ${panel === "spec" ? "on" : ""}`} onClick={() => panel === "spec" ? setPanel(null) : openPanel("spec")}>
            <span className="muted">내부</span> <b>CPU</b> {config.cpu_model} × {config.cpu_count} <span className="muted">·</span> <b>메모리</b> {config.memory.filter((row) => row.qty).map((row) => `${row.size_gb}GB × ${row.qty}`).join(" + ") || "없음"} = {memoryTotal}GB
            <span className="lnk specline-act">바꾸기</span>
          </button>
        {panel === "spec" && (
          <div className="slotpanel" ref={slotPanelRef} role="region" aria-label="CPU · 메모리">
            <div className="row between">
              <b>CPU · 메모리</b>
              <button className="ico" aria-label="닫기" onClick={() => setPanel(null)}>✕</button>
            </div>
            <div className="row">
              CPU <select value={config.cpu_model} onChange={(event) => patch({ cpu_model: event.target.value })} aria-label="CPU 모델">
                {server.cpu_options.map((option) => <option key={option}>{option}</option>)}
              </select>
              × <select value={config.cpu_count} onChange={(event) => patch({ cpu_count: Number(event.target.value) })} aria-label="CPU 수량">
                {Array.from({ length: server.cpu_sockets }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
              </select>
            </div>
            {config.memory.map((row, index) => (
              <div className="row" key={index}>
                메모리 <select value={row.size_gb} onChange={(event) => updateMemory(index, { size_gb: Number(event.target.value) })} aria-label="DIMM 용량">
                  {server.memory.dimm_sizes_gb.map((size) => <option key={size} value={size}>{size}GB RDIMM</option>)}
                </select>
                × <input type="number" min="0" max={server.memory.dimm_slots} value={row.qty} style={{ width: 70 }} onChange={(event) => updateMemory(index, { qty: Number(event.target.value) })} aria-label="DIMM 수량" />
                {config.memory.length > 1 && <button className="ico" aria-label="DIMM 행 삭제" onClick={() => patch({ memory: config.memory.filter((_, rowIndex) => rowIndex !== index) })}>✕</button>}
              </div>
            ))}
            <div className="row"><span className="muted">합계 {memoryTotal}GB · DIMM {memoryCount}/{server.memory.dimm_slots}</span><button type="button" className="lnk" onClick={() => patch({ memory: [...config.memory, { size_gb: 64, qty: 0 }] })}>+ 다른 DIMM</button></div>
          </div>
        )}
        {mode === "calib" && (
          <div className="calibbar" role="toolbar" aria-label="좌표 보정">
            <b>좌표 보정 중</b>
            <span className="muted">영역을 끌어 옮기고, 오른쪽 아래 모서리로 크기 조절 · 베이 {currentFrontRects.length}/{backplane.bays}</span>
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
        )}
        {calibrationMessage && <p className={calibrationMessage.includes("오류") ? "warn small" : "muted small"} role={calibrationMessage.includes("오류") ? "alert" : "status"}>{calibrationMessage}</p>}
        {imageBayMismatch && mode !== "calib" && candidates.length < backplane.bays && (
          <div className="hint">
            이 전면 이미지에는 베이가 {candidates.length}개뿐이라 {backplane.name} 구성을 모두 표시할 수 없습니다.
            {" "}{images?.front.auto === false
              ? <button className="btn small" onClick={() => void onUseAutoFront()}>기본 도면으로 보기</button>
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
        {imageView !== "rear" && (() => {
          const shared = filledSel.map((index) => config.bays[String(index)]);
          const shownDrive = shared.length && shared.every((bay) => bay.drive === shared[0].drive) ? shared[0].drive : currentDrive;
          const shownRole = shared.length && !emptySel.length && shared.every((bay) => bay.role === shared[0].role) ? shared[0].role : roleChoice;
          const emptyAll = Array.from({ length: backplane.bays }, (_, index) => index).filter((index) => !config.bays[String(index)]);
          const state = !filledSel.length ? "비어 있음"
            : !emptySel.length ? `사용 중${shared.every((bay) => bay.drive === shared[0].drive) ? ` · ${server.drive_options.find((drive) => drive.id === shared[0].drive)?.name || shared[0].drive}` : ""}`
            : `사용 중 ${filledSel.length} · 비어 있음 ${emptySel.length}`;
          return (
            <div className={`actbar ${selectedBays.length ? "on" : ""}`} ref={frontBarRef} role="region" aria-label="디스크 작업">
              {selectedBays.length ? (
                <div className="ar">
                  <span className="who">Bay {formatList(selectedSorted)}</span>
                  <span className="muted">{state}</span>
                  <select aria-label="디스크 종류" value={shownDrive} onChange={(event) => { setDiskChoice(event.target.value); changeFilled({ drive: event.target.value }); }}>
                    {driveOptions.map((drive) => <option key={drive.id} value={drive.id}>{drive.name}</option>)}
                  </select>
                  <span role="group" aria-label="용도" className="opts">
                    {(["data", "boot"] as const).map((role) => (
                      <button type="button" key={role} className="opt" aria-pressed={shownRole === role} onClick={() => { setRoleChoice(role); changeFilled({ role }); }}>{role === "data" ? "Data" : "Boot"}</button>
                    ))}
                  </span>
                  <button type="button" className="btn small" disabled={!emptySel.length || !currentDrive} onClick={installSelected}>꽂기{emptySel.length > 1 ? ` ${emptySel.length}개` : ""}</button>
                  <button type="button" className="btn small danger" disabled={!filledSel.length} onClick={removeBays}>빼기{filledSel.length > 1 ? ` ${filledSel.length}개` : ""}</button>
                </div>
              ) : (
                <div className="ar"><span className="muted">{backplane.bays
                  ? "베이를 클릭해 고르세요 · Shift+클릭이나 드래그로 여러 칸"
                  : `${backplane.name} — 전면 드라이브 베이가 없는 구성입니다`}</span></div>
              )}
              <div className="ar sub">
                {backplane.bays > 0 && emptyAll.length > 0 && <button type="button" className="lnk" onClick={() => { setSelectedSlot(null); setSelectedBays(emptyAll); }}>빈 베이 모두 선택 ({emptyAll.length})</button>}
                {backplane.bays > 0 && <button type="button" className="lnk" onClick={() => { setSelectedSlot(null); setSelectedBays(Array.from({ length: backplane.bays }, (_, index) => index)); }}>전체 선택</button>}
                <button type="button" className="lnk" aria-expanded={panel === "raid"} onClick={() => panel === "raid" ? setPanel(null) : openPanel("raid")}>RAID · BOSS 설정</button>
              </div>
            </div>
          );
        })()}
        {imageView !== "rear" && (
          <div className="storage-row">
            <StorageSummary server={server} config={config} bayCount={backplane.bays} />
            <span className="legend" aria-label="표시 설명">
              <span><i className="l-sel" />선택</span>
              <span><i className="l-warn" />확인 필요</span>
              <span><i className="l-off" />사용할 수 없는 칸</span>
            </span>
          </div>
        )}
        {panel === "raid" && (
          <div className="slotpanel" role="region" aria-label="RAID · BOSS">
            <div className="row between">
              <b>RAID · BOSS</b>
              <button className="ico" aria-label="닫기" onClick={() => setPanel(null)}>✕</button>
            </div>
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
          </div>
        )}
        {renderStage("rear")}
        {imageView !== "front" && (
          <div className={`actbar ${selectedSlot ? "on" : ""}`} ref={rearBarRef} role="region" aria-label="슬롯 · PSU 작업">
            {selectedSlot && selectedPsu >= 0 ? (() => {
              const filled = selectedPsu < config.psu_count;
              const psuImage = images?.psus?.[String(config.psu_watt)];
              return <>
                <div className="ar">
                  <span className="who">{psuSlots[selectedPsu].label}</span>
                  <span className="muted">{filled ? `${config.psu_watt}W 장착` : "비어 있음"} · PSU {config.psu_count}/{psuSlots.length}개</span>
                  <span className="opts" role="group" aria-label="PSU 용량">
                    {server.psu_options.map((watt) => (
                      <button type="button" key={watt} className="opt" aria-pressed={filled && config.psu_watt === watt}
                        onClick={() => patch({ psu_watt: watt, psu_count: Math.max(config.psu_count, selectedPsu + 1) })}>{watt}W</button>
                    ))}
                  </span>
                  <button type="button" className="btn small danger" disabled={!filled} onClick={() => patch({ psu_count: selectedPsu })}>빼기</button>
                </div>
                <div className="ar sub">
                  <span>같은 용량으로 장착합니다 (바꾸면 모두 바뀜) · 예상 최대 소비전력 {result ? `${Math.round(result.summary.power_est_w)}W` : "-"}</span>
                </div>
                {filled && psuImage && !psuImage.exact && <p className="warn small" style={{ margin: 0 }}>{config.psu_watt}W PSU 그림이 라이브러리에 없어 {psuImage.item?.name || "다른 PSU"} 그림에 용량을 표시했습니다.</p>}
                {psuWarn && <ul className="issues">{result?.general.filter((item) => item.status !== "충족" && /PSU|전원|소비전력/.test(item.msg)).map((item, i) => <li key={i}><StatusBadge status={item.status} /> {item.msg}</li>)}</ul>}
              </>;
            })() : selectedSlot ? (() => {
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
                <div className="ar">
                  <span className="who">{slot.label}</span>
                  <select aria-label={`${slot.label} 장착 부품`} value={config.slots[slot.id] || ""} onChange={(event) => setPart(event.target.value)}>
                    <option value="">(비움)</option>
                    {fits.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
                  </select>
                  {slot.riser && (
                    <span className="opts" role="group" aria-label={`${riser?.name || slot.riser} 장착`}>
                      <button type="button" className="opt" aria-pressed={riserOn} onClick={() => { if (!riserOn) patch({ risers: [...config.risers, slot.riser as string] }); }}>{riser?.name || slot.riser} 장착</button>
                      <button type="button" className="opt" aria-pressed={!riserOn} onClick={() => { if (riserOn) patch({ risers: config.risers.filter((id) => id !== slot.riser) }); }}>없음</button>
                    </span>
                  )}
                  <button type="button" className="btn small danger" disabled={!config.slots[slot.id]} onClick={() => setPart("")}>빼기</button>
                  {slotResult?.status && <StatusBadge status={slotResult.status} />}
                </div>
                <div className="ar sub">
                  <span>{slot.type === "ocp" ? `OCP 3.0 SFF x${slot.lanes}` : `PCIe Gen${slot.gen} x${slot.lanes} · ${slot.height}${slot.double_width_ok ? " · 더블 폭 가능" : ""}`} · CPU{slot.cpu}
                    {slotResult && !slotResult.usable ? ` · 지금은 사용 불가 (${slot.cpu > config.cpu_count ? `CPU ${slot.cpu}개 필요` : "Riser 필요"})` : ""}</span>
                </div>
                {!!slotResult?.issues.length && <ul className="issues">{slotResult.issues.map((issue, index) => <li key={index}><StatusBadge status={issue.status} /> {issue.msg}</li>)}</ul>}
              </>;
            })() : <>
              <div className="ar"><span className="muted">후면의 슬롯이나 PSU를 클릭하면 여기에서 바꿉니다</span></div>
              <div className="ar sub" />
            </>}
          </div>
        )}
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

        {(() => {
          if (!result) return null;
          const problems = [
            ...result.general.filter((item) => item.status !== "충족").map((item) => ({ where: "구성", what: "", status: item.status, msg: item.msg })),
            ...result.slots.filter((item) => item.component && item.status && item.status !== "충족").map((item) => ({ where: item.label, what: item.component || "", status: item.status || "", msg: item.issues.map((issue) => issue.msg).join(" / ") })),
            ...result.bays.filter((item) => item.status !== "충족").map((item) => ({ where: `Bay ${item.bay}`, what: item.drive, status: item.status, msg: item.issues.map((issue) => issue.msg).join(" / ") })),
          ];
          return (
            <details className="fold" id="s5">
              <summary><b>호환성</b> <span className="muted">— {problems.length ? `확인할 항목 ${problems.length}건` : "문제 없음"} · 예상 소비전력 {Math.round(result.summary.power_est_w)}W · 빈 PCIe {result.summary.free_pcie}개</span></summary>
              {problems.length ? <ul className="issues">{problems.map((item, index) => <li key={index}><StatusBadge status={item.status} /> <b>{item.where}</b>{item.what ? ` · ${item.what}` : ""} — {item.msg}</li>)}</ul>
                : <p className="muted small">장착한 부품과 디스크가 모두 호환됩니다.</p>}
            </details>
          );
        })()}
        </div>
      </section>
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
          <b>{row.role === "boot" ? "Boot" : "Data"}</b> {row.names.map(({ name, count }) => `${name} × ${count}`).join(" + ")} · {row.level || "No RAID"} · 원시 {formatGb(row.raw)}
          {row.usable === null ? ` · ${row.level}에 디스크 ${row.count}개는 구성 불가` : ` · 사용 가능 약 ${formatGb(row.usable)}`}
          {row.mixed && " · 서로 다른 디스크 혼용"}
        </span>
      ))}
    </div>
  );
}
