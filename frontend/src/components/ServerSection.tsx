import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { getImageJob, getLibrary, setImageMap, uploadImageLibrary } from "../api";
import type { Component, ImageStatus, LibraryImage, Server } from "../types";

interface Props {
  servers: Server[];
  components: Component[];
  server: Server | null;
  modelSource: "document" | "manual" | "default";
  modelHint: string | null;
  apiReady: boolean | null;
  backplaneId: string;
  images: ImageStatus | null;
  error: string;
  onServerChange: (id: string) => void;
  onBackplaneChange: (id: string) => void;
  onImagesChange: () => void;
  /** 바뀔 때마다 이미지 선택 창을 연다 (도구 메뉴에서 호출) */
  openImagesSignal?: number;
}

export default function ServerSection({
  servers,
  components,
  server,
  modelSource,
  modelHint,
  apiReady,
  backplaneId,
  images,
  error,
  onServerChange,
  onBackplaneChange,
  onImagesChange,
  openImagesSignal = 0,
}: Props) {
  const [library, setLibrary] = useState<LibraryImage[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState("");
  const [managerOpen, setManagerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "server" | "nic" | "fc" | "disk" | "psu" | "gpu" | "other">("all");
  const [side, setSide] = useState<"all" | "front" | "rear">("all");
  const [modelFilter, setModelFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [forceLink, setForceLink] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (openImagesSignal) setManagerOpen(true);
  }, [openImagesSignal]);

  useEffect(() => {
    if (apiReady !== true) return;
    getLibrary()
      .then((items) => setLibrary(items))
      .catch((reason: unknown) => setImageError(reason instanceof Error ? reason.message : String(reason)));
  }, [apiReady, images?.library_count]);

  if (!server) return <span className="muted">{apiReady === false ? "API 연결 후 서버 모델을 불러옵니다." : "서버 목록을 불러오는 중…"}</span>;

  const selectedBackplane = server.backplanes.find((item) => item.id === backplaneId) || server.backplanes[0];
  /** 보관함 분류 — 이미지 분류(category)와 이름으로 */
  const tabOf = (item: LibraryImage): typeof tab => {
    if (item.category === "server_front" || item.category === "server_rear") return "server";
    if (item.category === "drive" || item.category === "blank") return "disk";
    if (item.category === "psu") return "psu";
    const n = item.name.toLowerCase();
    // BOSS-N1·M.2 인터포저 같은 모듈은 NIC 가 아니다 — 이름에 네트워크 단서가 있을 때만 NIC/OCP
    if (item.category === "module") return /ndc|lom|nic|ethernet|sfp|base-?t|\d+\s*gb?e/.test(n) ? "nic" : "other";
    if (item.category === "ocp") return "nic";
    if (/fc|hba|fibre|fiber|qle|lpe/.test(n)) return "fc";
    if (/gpu|nvidia|\ba40\b|\bl4\b|h100|a100/.test(n)) return "gpu";
    if (/nic|sfp|rj-?45|ethernet|mellanox|broadcom|\d+\s*gb?e|base-?t/.test(n)) return "nic";
    return "other";
  };
  const TABS: Array<[typeof tab, string]> = [["all", "전체"], ["server", "서버"], ["nic", "NIC/OCP"], ["fc", "FC HBA"], ["disk", "Disk"], ["psu", "PSU"], ["gpu", "GPU"], ["other", "기타"]];
  const modelOf = (item: LibraryImage) => (item.name.match(/^[A-Za-z]{1,2}\d{3,4}[A-Za-z]*/) || [""])[0].toUpperCase();
  const models = [...new Set(library.filter((item) => tabOf(item) === "server").map(modelOf).filter(Boolean))].sort();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = library.filter((item) => {
    const t = tabOf(item);
    if (tab !== "all" && t !== tab) return false;
    if (t === "server" && side !== "all" && item.category !== (side === "front" ? "server_front" : "server_rear")) return false;
    if (t === "server" && modelFilter && modelOf(item) !== modelFilter) return false;
    if ((tab === "all" || tab === "server") && modelFilter && t !== "server") return false;
    return terms.every((term) => `${item.name} ${item.source}`.toLowerCase().includes(term));
  });
  const counts = Object.fromEntries(TABS.map(([id]) => [id, id === "all" ? library.length : library.filter((item) => tabOf(item) === id).length]));
  const selected = library.find((item) => item.id === selectedId) || null;

  /** 이미지 이름에서 읽은 포트 수·속도·형태 vs 부품 사양 — 다르면 경고 (임의 연결 금지) */
  const imageSpec = (name: string) => {
    const n = name.toLowerCase();
    const ports = n.match(/(\d+)\s*x\s*(?:\d|sfp|rj|base)/)?.[1] ?? (/quad/.test(n) ? "4" : /dual/.test(n) ? "2" : /single/.test(n) ? "1" : undefined);
    const speed = n.match(/\d+\s*x\s*(\d+)\s*g/)?.[1];
    const media = /sfp28|sfp\+|sfp/.test(n) ? "SFP" : /base-?t|\bbt\b|rj-?45/.test(n) ? "RJ45" : undefined;
    return { ports: ports ? Number(ports) : undefined, speed: speed ? Number(speed) : undefined, media };
  };
  const compatWarn = (item: LibraryImage | null, componentId: string): string => {
    if (!item || !componentId.startsWith("component:")) return "";
    const comp = components.find((c) => c.id === componentId.slice(10));
    if (!comp) return "";
    const spec = imageSpec(item.name);
    const diffs: string[] = [];
    if (spec.ports && comp.ports && spec.ports !== comp.ports) diffs.push(`포트 수 ${spec.ports}개 ≠ ${comp.ports}개`);
    if (spec.speed && comp.speed_gb && spec.speed !== comp.speed_gb) diffs.push(`속도 ${spec.speed}G ≠ ${comp.speed_gb}G`);
    const compMedia = /sfp/i.test(comp.name) ? "SFP" : /base-?t|rj-?45|\bbt\b|\b1gbit cu\b|\bcu\b/i.test(comp.name) ? "RJ45" : undefined;
    if (spec.media && compMedia && spec.media !== compMedia) diffs.push(`포트 형태 ${spec.media} ≠ ${compMedia}`);
    return diffs.join(", ");
  };
  const matchRank = (item: LibraryImage | null, value: string) => compatWarn(item, value) ? 1 : 0;
  /** 선택한 이미지를 연결할 수 있는 대상 */
  const targetsFor = (item: LibraryImage | null): Array<{ value: string; label: string }> => {
    if (!item) return [];
    const t = tabOf(item);
    if (t === "server") return item.category === "server_front"
      ? [{ value: `front:${backplaneId}`, label: `서버 전면 · ${selectedBackplane?.name}` }] : [{ value: "rear:rear", label: "서버 후면" }];
    if (t === "psu") return server.psu_options.map((watt) => ({ value: `psu:${watt}`, label: `PSU ${watt}W` }));
    if (t === "disk") return item.category === "blank" ? [] : server.drive_options.flatMap((drive) => (drive.ff === "2.5" ? ["V", "H"] : ["V"]).map((o) => ({
      value: `drive:${drive.id}:${o}`, label: `${drive.name}${drive.ff === "2.5" ? o === "V" ? " · 세로 베이" : " · 가로 베이" : ""}` })));
    const cats = t === "nic" ? ["NIC", "OCP NIC"] : t === "fc" ? ["FC HBA"] : t === "gpu" ? ["GPU"] : null;
    return components.filter((component) => !cats || cats.includes(component.category))
      .filter((component) => t !== "nic" || (item.category === "ocp" || item.category === "module" ? component.form === "ocp" : true))
      .map((component) => ({ value: `component:${component.id}`, label: `${component.name} (${component.category})` }));
  };
  const targets = [...targetsFor(selected)].sort((a, b) => matchRank(selected, a.value) - matchRank(selected, b.value));
  const currentTarget = targets.some((item) => item.value === linkTarget) ? linkTarget : targets[0]?.value || "";
  const warn = compatWarn(selected, currentTarget);
  /** 지금 적용 중인 이미지 이름 (대상별) */
  const appliedItem = (value: string): { name: string; auto: boolean } | null => {
    const [kind, ...rest] = value.split(":");
    const key = rest.join(":");
    const pick = kind === "front" ? images?.front : kind === "rear" ? images?.rear : kind === "psu" ? images?.psus?.[key]
      : kind === "drive" ? images?.drives?.[key] : kind === "component" ? images?.components?.[key] : null;
    return pick?.item ? { name: pick.item.name, auto: pick.auto !== false } : null;
  };
  const appliedBadge = (item: LibraryImage) => {
    const out: string[] = [];
    if (images?.front.item?.id === item.id) out.push("전면");
    if (images?.rear.item?.id === item.id) out.push("후면");
    Object.entries(images?.components || {}).forEach(([cid, v]) => { if (v.item?.id === item.id && v.auto === false) out.push(components.find((c) => c.id === cid)?.short || cid); });
    return out.join("·");
  };
  const link = async (value: string, itemId: string | null) => {
    const [kind, ...rest] = value.split(":");
    setSaving(true);
    try {
      await setImageMap(server.id, kind as "front" | "rear" | "component" | "drive" | "psu", rest.join(":"), itemId);
      setImageError("");
      setSaved(itemId ? "연결했습니다 — 서버 그림에 반영됩니다" : "자동 이미지로 되돌렸습니다");
      window.setTimeout(() => setSaved(""), 2500);
      onImagesChange();
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const closeManager = () => { setManagerOpen(false); setSaved(""); };

  const serverSpec: Array<[string, string | number]> = [
    ["Form Factor", server.form_factor],
    ["CPU Socket", server.cpu_sockets],
    ["DIMM Slot", server.memory.dimm_slots],
    ["Max Memory", `${server.memory.max_gb / 1024}TB`],
    ["PCIe", server.pcie_gen],
    ["PCIe Slot", server.slots.filter((slot) => slot.type === "pcie").length],
    ["OCP", server.ocp.supported ? `OCP ${server.ocp.version} x${server.ocp.lanes}` : "미지원"],
    ["PSU Bay", server.psu_bays],
    ["GPU", server.gpu.supported ? `DW ${server.gpu.max_double_width} / SW ${server.gpu.max_single_width}` : "미지원"],
    ["CPU2 의존 슬롯", server.slots.filter((slot) => slot.cpu === 2).map((slot) => slot.label).join(", ") || "-"],
  ];


  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void upload(files);
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setUploadPercent(0);
    setUploadMessage("업로드 중…");
    setImageError("");
    try {
      const { job } = await uploadImageLibrary(files);
      for (;;) {
        const result = await getImageJob(job);
        const stageRanges: Record<string, [number, number]> = { parse: [0, 5], convert: [5, 60], render: [65, 35] };
        const [base, width] = stageRanges[result.stage] || [0, 0];
        setUploadPercent(result.total ? Math.round(base + result.done / result.total * width) : 0);
        setUploadMessage(result.message);
        if (result.state !== "running") {
          if (result.state !== "done") throw new Error(result.message || "이미지 처리에 실패했습니다.");
          setUploadPercent(100);
          setUploadMessage(`${result.message}${result.elapsed ? ` (${result.elapsed}초)` : ""}`);
          onImagesChange();
          setLibrary(await getLibrary());
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
      setUploadMessage("이미지 처리 실패");
    } finally {
      setBusy(false);
    }
  };

  const sourceTag = modelSource === "document"
    ? <span className="tag tag-auto">문서에서 자동 선택{modelHint ? ` · ${modelHint}` : ""}</span>
    : modelSource === "manual"
      ? <span className="tag">직접 선택</span>
      : <span className="tag tag-warn">{modelHint ? `문서의 ${modelHint}는 카탈로그에 없음 — 모델을 확인하세요` : "문서에 모델 없음 — 기본값"}</span>;

  return (
    <div className="modelline">
      <b className="cardtitle">견적사항</b>
      <span className="modelname">· {server.vendor} {server.model}</span>
      {sourceTag}
      <button type="button" className="lnk" aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}>변경</button>
      {error && <span className="warn small" role="alert">{error}</span>}
      {pickerOpen && (
        <div className="modelpop" role="dialog" aria-label="모델 · 백플레인 변경">
          <label>모델
            <select value={server.id} onChange={(event) => onServerChange(event.target.value)}>
              {servers.map((item) => <option key={item.id} value={item.id}>{item.vendor} {item.family} {item.model}</option>)}
            </select>
          </label>
          <label>백플레인(전면)
            <select value={selectedBackplane?.id || ""} onChange={(event) => onBackplaneChange(event.target.value)}>
              {server.backplanes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <details className="specbox">
            <summary>서버 사양 보기</summary>
            <dl className="specs">{serverSpec.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </details>
          <div className="row between">
            <button type="button" className="btn ghost small" onClick={() => { setManagerOpen(true); setPickerOpen(false); }}>서버 이미지 변경</button>
            <button type="button" className="btn small" onClick={() => setPickerOpen(false)}>닫기</button>
          </div>
        </div>
      )}
      {managerOpen && (
        <div className="modal-back" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeManager(); }}>
          <div className="modal vault" role="dialog" aria-modal="true" aria-label="이미지 보관함">
            <div className="row between">
              <h3>이미지 보관함 <span className="muted small">· {server.vendor} {server.model}</span></h3>
              <button className="ico" aria-label="닫기" onClick={closeManager}>✕</button>
            </div>
            <p className="small vault-now">현재 연결 — 전면: <b>{images?.front.item?.name || "없음"}</b> / 후면: <b>{images?.rear.item?.name || "없음"}</b></p>
            <div className={`vault-drop ${dropping ? "over" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDropping(true); }} onDragLeave={() => setDropping(false)}
              onDrop={(event) => { event.preventDefault(); setDropping(false); void upload(Array.from(event.dataTransfer.files)); }}>
              <span>파일을 끌어 놓거나 선택하세요 <span className="muted small">VSSX · VSDX · PNG · JPG</span></span>
              <label className="btn small">
                <input type="file" accept=".vssx,.vsdx,.vstx,.png,.jpg,.jpeg,.webp,.bmp,.gif" multiple hidden disabled={busy} onChange={handleUpload} />
                이미지 업로드
              </label>
              {!!uploadMessage && (
                <div className={`job ${!busy && uploadPercent === 100 ? "fin" : ""}`}>
                  <div className="bar"><i style={{ width: `${uploadPercent}%` }} /></div><span>{uploadMessage}</span>
                </div>
              )}
            </div>
            <div className="vault-tabs" role="tablist" aria-label="이미지 분류">
              {TABS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label} <small>{counts[id]}</small></button>
              ))}
            </div>
            <div className="row vault-filter">
              <input type="search" placeholder="이름·모델 검색 (예: R760, 8D, 25Gb)" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="이미지 검색" />
              {(tab === "all" || tab === "server") && !!models.length && (
                <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} aria-label="모델">
                  <option value="">모델: 전체</option>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              )}
              {tab === "server" && (
                <span className="opts" role="group" aria-label="전면·후면">
                  {([["all", "전체"], ["front", "전면"], ["rear", "후면"]] as const).map(([id, label]) => <button key={id} type="button" className="opt" aria-pressed={side === id} onClick={() => setSide(id)}>{label}</button>)}
                </span>
              )}
              <span className="muted small">{shown.length}개</span>
            </div>
            <div className="libgrid vault-list">
              {shown.map((item) => {
                const badge = appliedBadge(item);
                return (
                  <button type="button" key={item.id} title={`${item.name}\n${item.source}`}
                    className={`libcard pickable ${selectedId === item.id ? "chosen" : ""}`} aria-pressed={selectedId === item.id}
                    onClick={() => { setSelectedId(item.id); setLinkTarget(""); setForceLink(false); }}>
                    {badge && <em className="used-badge" title="지금 적용 중">✓ {badge}</em>}
                    <img src={`/static/${item.file}`} alt="" loading="lazy" />
                    <span>{item.name}</span><small>{TABS.find(([id]) => id === tabOf(item))?.[1]} · {item.source}</small>
                  </button>
                );
              })}
              {!shown.length && <p className="muted">{library.length ? "조건에 맞는 이미지가 없습니다." : "보관함이 비어 있습니다. 위에서 스텐실이나 이미지를 올려 주세요."}</p>}
            </div>
            {imageError && <p className="warn" role="alert">{imageError}</p>}
            <div className="modal-foot vault-foot">
              {selected ? <>
                <span className="vault-sel"><b>선택한 이미지:</b> {selected.name}</span>
                {targets.length ? <>
                  <label>연결 대상
                    <select value={currentTarget} onChange={(event) => setLinkTarget(event.target.value)} aria-label="연결 대상">
                      {targets.map((item) => <option key={item.value} value={item.value}>{matchRank(selected, item.value) ? "" : "✓ "}{item.label}</option>)}
                    </select>
                  </label>
                  {appliedItem(currentTarget) && <span className="muted small">지금: {appliedItem(currentTarget)?.name}{appliedItem(currentTarget)?.auto ? " (자동)" : ""}</span>}
                  <button type="button" className="btn ghost" disabled={saving} onClick={() => setSelectedId(null)}>취소</button>
                  <button type="button" className="btn ghost" disabled={saving || !currentTarget} onClick={() => void link(currentTarget, null)} title="직접 연결을 풀고 자동 이미지로 되돌립니다">자동으로 되돌리기</button>
                  <button type="button" className="btn" disabled={saving || !currentTarget || (!!warn && !forceLink)} onClick={() => void link(currentTarget, selected.id)}>{saving ? "저장 중…" : "저장하기"}</button>
                </> : <span className="muted small">이 이미지는 연결할 대상이 없습니다 (그림 합성에 쓰이지 않는 종류)</span>}
              </> : <span className="muted small">이미지를 눌러 고르면 아래에서 연결 대상을 정할 수 있습니다</span>}
              {warn && <label className="vault-warn" role="alert">⚠ 이미지와 부품 사양이 달라 보입니다 ({warn}). <input type="checkbox" checked={forceLink} onChange={(event) => setForceLink(event.target.checked)} /> 그래도 연결</label>}
              {saved && <span className="tag tag-auto" role="status">{saved}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
