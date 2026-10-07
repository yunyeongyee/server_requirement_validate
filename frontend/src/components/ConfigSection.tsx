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
  renderedImages: { front: string | null; rear: string | null };
  onChange: (config: ServerConfig) => void;
  onBackplaneChange: (id: string) => void;
  onSaveCalibration: (hotspots: Record<string, Rect>, rects: Rect[]) => Promise<void>;
  onRedetectBays: () => Promise<void>;
  /** 카드 머리에 들어갈 모델 줄 (모델 · 출처 · 변경) */
  modelLine: ReactNode;
  /** 요구사항 행의 '추가/수정' 버튼이 보낸 요청. n 이 바뀔 때마다 처리 */
  focus: FocusRequest | null;
  onOpenImages: () => void;
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
}: Props) {
  const [imageView, setImageView] = useState<"both" | "front" | "rear">("both");
  const [mode, setMode] = useState<"edit" | "clean" | "calib">("edit");
  const [selectedBays, setSelectedBays] = useState<number[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showSlotList, setShowSlotList] = useState(false);
  /** 그림 아래 설정 자리에 띄울 것: 디스크(선택 베이·RAID) / CPU·메모리. 슬롯·PSU는 selectedSlot */
  const [panel, setPanel] = useState<"disk" | "spec" | null>(null);
  const slotPanelRef = useRef<HTMLDivElement>(null);
  const [frontRects, setFrontRects] = useState<Rect[]>([]);
  const [slotHotspots, setSlotHotspots] = useState<Record<string, Rect>>({});
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState("");
  const drag = useRef<DragState | null>(null);
  function openPanel(next: "disk" | "spec") {
    setSelectedSlot(null);
    if (next === "spec") setSelectedBays([]);
    setPanel(next);
    window.setTimeout(() => slotPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  }

  useEffect(() => {
    setFrontRects(images?.bays.rects || []);
  }, [server?.id, config?.backplane, images?.bays.rects]);
  useEffect(() => {
    const next: Record<string, Rect> = {};
    [...(server?.slots || []), ...(server?.psu_slots || [])].forEach((slot) => {
      if (slot.hotspot) next[slot.id] = { ...slot.hotspot };
    });
    (server?.rear_blocked || []).forEach((area, index) => { next[`blk:${index}`] = { ...area }; });
    setSlotHotspots(next);
  }, [server]);

  useEffect(() => {
    if (!focus || !server) return;
    if (focus.kind === "bays") {
      openPanel("disk");
    } else if (focus.kind === "spec") {
      openPanel("spec");
    } else if (focus.kind === "slot" && focus.part === "psu") {
      const psuSlots = server.psu_slots || [];
      const target = psuSlots[Math.min(config?.psu_count || 0, psuSlots.length - 1)];
      if (target) {
        setPanel(null);
        setSelectedSlot(target.id);
        window.setTimeout(() => slotPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
      } else {
        openPanel("spec");
      }
    } else if (focus.kind === "slot") {
      const free = server.slots.find((slot) => slot.type !== "ocp" && !config?.slots[slot.id]
        && (result?.slots.find((item) => item.slot === slot.id)?.usable ?? true));
      if (free) {
        setPanel(null);
        setSelectedSlot(free.id);
        window.setTimeout(() => slotPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
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

  const toggleBay = (bay: number) => {
    setSelectedSlot(null);
    setPanel("disk");
    setSelectedBays((selected) => selected.includes(bay)
      ? selected.filter((item) => item !== bay)
      : [...selected, bay]);
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
    setCalibrationMessage(`Bay 0 크기로 ${n}개를 같은 간격으로 배치했습니다. 확인 후 '좌표 저장'을 누르세요.`);
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
    setCalibrationMessage("사용할 베이를 바꿨습니다. '좌표 저장'을 눌러야 반영됩니다.");
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
      setCalibrationMessage("좌표 저장 완료");
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
  const psuIndex = (id: string) => psuSlots.findIndex((psu) => psu.id === id);
  const psuWarn = !!result?.general.some((item) => item.status !== "충족" && /PSU|전원|소비전력/.test(item.msg));

  const renderStage = (view: "front" | "rear") => {
    const info = images?.[view];
    const rendered = renderedImages[view] || info?.item?.url || null;
    const isVisible = imageView === "both" || imageView === view;
    const areas = view === "front"
      ? currentFrontRects.map((area, index) => ({ area, slot: undefined, index }))
      : [...server.slots, ...psuSlots].flatMap((slot, index) => slotHotspots[slot.id] ? [{ area: slotHotspots[slot.id], slot, index }] : []);
    return (
      <figure className="stage" key={view} hidden={!isVisible}>
        <figcaption><b>{view === "front" ? "Front" : "Rear"}</b><span className="muted">{info?.item?.name || "실제 이미지 미지정"}</span></figcaption>
        {rendered ? (
          <div className={`chassis mode-${mode}`}>
            <img src={rendered} alt={`${server.vendor} ${server.model} ${view === "front" ? "전면" : "후면"}`} />
            <div className="hot" onPointerDown={(event) => startDrag(view, event)} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
              {areas.map(({ area, slot, index }) => {
                const bayIndex = index;
                const bay = config.bays[String(bayIndex)];
                const status = view === "front" ? getBayResult(bayIndex)?.status : slot ? getSlotResult(slot.id)?.status : null;
                const className = view === "front"
                  ? `bay ${selectedBays.includes(bayIndex) ? "sel" : ""} ${bay?.role === "boot" ? "boot" : ""} ${status === "호환 불가" ? "s-incomp" : status === "확인 필요" ? "s-review" : ""}`
                  : slot?.type === "psu"
                  ? `hs psu ${selectedSlot === slot.id ? "sel" : ""} ${psuIndex(slot.id) < config.psu_count ? (psuWarn ? "s-review" : "s-ok") : "empty"}`
                  : slot && getSlotResult(slot.id)?.usable === false
                  ? `hs s-off ${selectedSlot === slot.id ? "sel" : ""}`
                  : `hs ${selectedSlot === slot?.id ? "sel" : ""} ${status === "충족" ? "s-ok" : status === "호환 불가" ? "s-incomp" : status === "확인 필요" ? "s-review" : ""}`;
                return (
                  <button
                    key={view === "front" ? `bay-${index}` : slot?.id || index}
                    className={className}
                    type="button"
                    title={view === "front" ? `Bay ${index} · ${bay ? `${server.drive_options.find((drive) => drive.id === bay.drive)?.name || bay.drive} (${bay.role === "boot" ? "Boot" : "Data"})` : "비어 있음"}` : slot?.label}
                    aria-label={view === "front" ? `Bay ${index}${bay ? " 사용 중" : " 비어 있음"}` : slot?.label}
                    data-calib-key={view === "front" ? String(index) : slot?.id}
                    data-tip={view === "rear" && slot && getSlotResult(slot.id)?.usable === false
                      ? unusableReason(slot) : undefined}
                    style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%` }}
                    onClick={() => {
                      if (mode !== "edit") return;
                      if (view === "front") toggleBay(index);
                      else if (slot) { setPanel(null); setSelectedBays([]); setSelectedSlot((current) => current === slot.id ? null : slot.id); }
                    }}
                  >
                    {view === "front" ? <span className="bn">{index}</span> : slot?.type === "psu"
                      ? <><span className="tag">{slot.label}</span><span className="psu-w">{psuIndex(slot.id) < config.psu_count ? `${config.psu_watt}W` : "비어 있음"}</span></>
                      : <span className="tag">{slot?.label}</span>}
                    {mode === "calib" && <span className="grip" />}
                    {mode === "calib" && view === "front" && (
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
              })}
              {view === "rear" && Object.entries(slotHotspots).filter(([key]) => key.startsWith("blk:")).map(([key, area]) => (
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
            <p><strong>{server.model} {view === "front" ? "전면" : "후면"} 실제 이미지가 없습니다.</strong></p>
            <p>2단계에서 Dell PowerEdge Rack Servers 스텐실(VSSX) 또는 VSDX를 올리면 자동으로 연결됩니다.</p>
            <p className="muted">이미지가 없어도 구성 목록에서 부품 및 디스크를 지정하고 검증할 수 있습니다.</p>
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
            {mode !== "edit" && <span className="tag">{mode === "calib" ? "좌표 보정 중" : "제안서 보기"} <button type="button" className="lnk" onClick={() => setMode("edit")}>끝내기</button></span>}
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
        {mode === "calib" && <div className="row">
          <span className="muted">빠른 방법: Bay 0의 크기·위치와 마지막 베이 위치만 맞춘 뒤 '처음·끝 사이 균등 배치'를 누르세요. 점선(+) 칸은 이미지에서 찾았지만 쓰지 않는 베이로, 클릭하면 추가됩니다. 사용 중 베이는 ✕로 뺄 수 있습니다. ({currentFrontRects.length}/{backplane.bays}베이)</span>
          <button className="btn ghost small" disabled={calibrationBusy} onClick={() => void redetect()}>베이 자동 감지 다시</button>
          <button className="btn ghost small" onClick={copyFirstSize} title="Bay 0의 너비·높이·세로 위치를 모든 베이에 복사">Bay 0 크기를 전체에 적용</button>
          <button className="btn ghost small" onClick={distributeBays} title="Bay 0과 마지막 베이 위치만 맞추면 사이를 같은 간격으로 채움">처음·끝 사이 균등 배치</button>
          {imageBayMismatch && <>
            <button className="btn ghost small" onClick={() => useCandidates("start")}>왼쪽부터 {backplane.bays}개 사용</button>
            <button className="btn ghost small" onClick={() => useCandidates("end")}>오른쪽부터 {backplane.bays}개 사용</button>
          </>}
          <button className="btn ghost small" title="후면 그림에서 이 모델로 쓸 수 없는 자리를 검정 박스로 가립니다" onClick={() => {
            const used = Object.keys(slotHotspots).filter((key) => key.startsWith("blk:")).map((key) => Number(key.slice(4)));
            const next = used.length ? Math.max(...used) + 1 : 0;
            setSlotHotspots((current) => ({ ...current, [`blk:${next}`]: { x: 42, y: 40, w: 14, h: 22, reason: BLOCK_REASON } }));
            setCalibrationMessage("후면에 가림 영역을 추가했습니다. 옮기고 크기를 맞춘 뒤 '좌표 저장'을 누르세요.");
          }}>후면 가림 영역 추가</button>
          <button className="btn small" disabled={calibrationBusy} onClick={() => void saveCalibration()}>좌표 저장</button>
          {calibrationMessage && <span className={calibrationMessage.includes("오류") ? "warn" : "muted"} role={calibrationMessage.includes("오류") ? "alert" : undefined}>{calibrationMessage}</span>}
        </div>}
        {imageBayMismatch && (
          <div className="hint">
            전면 이미지에는 베이가 {candidates.length}개 보이는데 선택한 백플레인은 {backplane.bays}베이입니다.
            {matchingBackplane && <> <button className="btn small" onClick={() => onBackplaneChange(matchingBackplane.id)}>백플레인을 {matchingBackplane.name}(으)로 변경</button></>}
            {" "}<button className="btn ghost small" onClick={() => setMode("calib")}>사용할 베이 고르기</button>
          </div>
        )}
        {renderStage("front")}
        <div className="storage-row">
          <StorageSummary server={server} config={config} bayCount={backplane.bays} />
          {backplane.bays > 0 && <span className="muted small">베이를 눌러 디스크·RAID 설정</span>}
        </div>
        {renderStage("rear")}
        {panel === "disk" && (
          <div className="slotpanel" ref={slotPanelRef} role="region" aria-label="디스크 · RAID">
            <div className="row between">
              <b>{selectedBays.length ? `전면 Bay ${[...selectedBays].sort((a, b) => a - b).join(", ")} 선택됨` : "디스크 · RAID"}</b>
              <span className="muted">베이를 더 눌러 여러 개 선택 · <button type="button" className="lnk" onClick={() => setSelectedBays(Array.from({ length: backplane.bays }, (_, index) => index).filter((index) => !config.bays[String(index)]))}>빈 베이 전체</button></span>
              <button className="ico" aria-label="닫기" onClick={() => { setPanel(null); setSelectedBays([]); }}>✕</button>
            </div>
            <div className="row">
              디스크 <select id="addDrive" aria-label="디스크 모델" defaultValue={server.drive_options.find((drive) => drive.ff === backplane.ff)?.id || ""}>
                {server.drive_options.filter((drive) => drive.ff === backplane.ff).map((drive) => <option key={drive.id} value={drive.id}>{drive.name}</option>)}
              </select>
              용도 <select id="addRole" aria-label="디스크 용도"><option value="data">Data</option><option value="boot">Boot</option></select>
              <button className="btn small" disabled={!selectedBays.length} onClick={() => {
                const drive = (document.getElementById("addDrive") as HTMLSelectElement).value;
                const role = (document.getElementById("addRole") as HTMLSelectElement).value as "boot" | "data";
                const bays = { ...config.bays };
                selectedBays.forEach((index) => { bays[String(index)] = { drive, role }; });
                patch({ bays });
                setSelectedBays([]);
              }}>장착</button>
              <button className="btn ghost small" disabled={!selectedBays.length} onClick={() => {
                const bays = { ...config.bays };
                selectedBays.forEach((index) => delete bays[String(index)]);
                patch({ bays });
                setSelectedBays([]);
              }}>빼기</button>
              <button className="btn ghost small" onClick={() => { patch({ bays: {} }); setSelectedBays([]); }}>전체 빼기</button>
            </div>
            <div className="row" role="group" aria-label="Data RAID">
              Data RAID {RAID_LEVELS.map((level) => (
                <button type="button" key={level || "none"} className="opt" aria-pressed={config.raid.data === level} onClick={() => patch({ raid: { ...config.raid, data: level } })}>{level || "No RAID"}</button>
              ))}
            </div>
            <div className="row">
              Boot RAID <select value={config.raid.boot} onChange={(event) => patch({ raid: { ...config.raid, boot: event.target.value } })} aria-label="Boot RAID">
                {RAID_LEVELS.map((level) => <option key={level} value={level}>{level || "No RAID"}</option>)}
              </select>
              <label><input type="checkbox" checked={config.boss} onChange={(event) => patch({ boss: event.target.checked })} /> BOSS-N1 (M.2 × 2, RAID1 부트)</label>
            </div>
          </div>
        )}
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
        {selectedSlot && psuIndex(selectedSlot) >= 0 && (() => {
          const index = psuIndex(selectedSlot);
          const filled = index < config.psu_count;
          return (
            <div className="slotpanel" ref={slotPanelRef} role="region" aria-label={`${psuSlots[index].label} 구성`}>
              <div className="row between">
                <b>{psuSlots[index].label}</b>
                <span className="muted">{filled ? `${config.psu_watt}W 장착` : "비어 있음"} · 전원 공급 장치 {config.psu_count}/{psuSlots.length}개</span>
                <button className="ico" aria-label="PSU 패널 닫기" onClick={() => setSelectedSlot(null)}>✕</button>
              </div>
              <div className="opts" role="group" aria-label="PSU 용량">
                {server.psu_options.map((watt) => (
                  <button type="button" key={watt} className="opt" aria-pressed={filled && config.psu_watt === watt}
                    onClick={() => patch({ psu_watt: watt, psu_count: Math.max(config.psu_count, index + 1) })}>{watt}W</button>
                ))}
                {filled && <button type="button" className="opt" onClick={() => patch({ psu_count: index })}>빼기</button>}
              </div>
              {filled && images?.psus?.[String(config.psu_watt)] && !images.psus[String(config.psu_watt)].exact && (
                <p className="warn small">{config.psu_watt}W PSU 이미지가 라이브러리에 없어 {images.psus[String(config.psu_watt)].item?.name || "다른 PSU"} 그림에 용량을 표시했습니다. Dell 스텐실에서 해당 PSU 이미지를 올리면 자동으로 바뀝니다.</p>
              )}
              <p className="muted small">한 서버의 PSU는 같은 용량으로 장착합니다. 용량을 바꾸면 장착된 PSU 모두 바뀝니다. 예상 최대 소비전력 {result ? `${Math.round(result.summary.power_est_w)}W` : "-"}.</p>
              {psuWarn && <ul className="issues">{result?.general.filter((item) => /PSU|전원|소비전력/.test(item.msg)).map((item, i) => <li key={i}><StatusBadge status={item.status} /> {item.msg}</li>)}</ul>}
            </div>
          );
        })()}
        {selectedSlot && psuIndex(selectedSlot) < 0 && (() => {
          const slot = server.slots.find((item) => item.id === selectedSlot);
          if (!slot) return null;
          const slotResult = getSlotResult(slot.id);
          const fits = components.filter((item) => slot.type === "ocp" ? item.form === "ocp" : item.form !== "ocp");
          return (
            <div className="slotpanel" ref={slotPanelRef} role="region" aria-label={`${slot.label} 구성`}>
              <div className="row between">
                <b>{slot.label}</b>
                <span className="muted">{slot.type === "ocp" ? `OCP 3.0 SFF x${slot.lanes}` : `PCIe Gen${slot.gen} x${slot.lanes} · ${slot.height}${slot.double_width_ok ? " · 더블 폭 가능" : ""}`} · CPU{slot.cpu}{slot.riser ? ` · ${server.risers.find((riser) => riser.id === slot.riser)?.name || slot.riser}` : ""}</span>
                <button className="ico" aria-label="슬롯 패널 닫기" onClick={() => setSelectedSlot(null)}>✕</button>
              </div>
              <div className="row">
                <select aria-label={`${slot.label} 장착 부품`} value={config.slots[slot.id] || ""} onChange={(event) => {
                  const slots = { ...config.slots };
                  if (event.target.value) slots[slot.id] = event.target.value;
                  else delete slots[slot.id];
                  patch({ slots });
                }}>
                  <option value="">(비움)</option>
                  {fits.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}
                </select>
                {slotResult?.status ? <StatusBadge status={slotResult.status} /> : <span className="muted">{slotResult && !slotResult.usable ? "사용 불가 (CPU 수 또는 Riser 미장착)" : "빈 슬롯"}</span>}
              </div>
              {slot.riser && (() => {
                const riser = server.risers.find((item) => item.id === slot.riser);
                const on = config.risers.includes(slot.riser);
                return (
                  <div className="row" role="group" aria-label={`${riser?.name || slot.riser} 장착`}>
                    {riser?.name || slot.riser}
                    <button type="button" className="opt" aria-pressed={on} onClick={() => { if (!on) patch({ risers: [...config.risers, slot.riser as string] }); }}>장착</button>
                    <button type="button" className="opt" aria-pressed={!on} onClick={() => { if (on) patch({ risers: config.risers.filter((id) => id !== slot.riser) }); }}>없음</button>
                    {!on && <span className="muted small">Riser가 없으면 이 슬롯을 쓸 수 없습니다</span>}
                  </div>
                );
              })()}
              {!!slotResult?.issues.length && <ul className="issues">{slotResult.issues.map((issue, index) => <li key={index}><StatusBadge status={issue.status} /> {issue.msg}</li>)}</ul>}
            </div>
          );
        })()}
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
