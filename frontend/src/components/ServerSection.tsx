import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { getImageJob, getLibrary, setImageMap, uploadImageLibrary } from "../api";
import type { Component, ImageRef, ImageStatus, LibraryImage, Server } from "../types";

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
  const [target, setTarget] = useState<"front" | "rear">("front");
  const [pending, setPending] = useState<Record<string, { kind: string; key: string; itemId: string | null }>>({});
  const [saving, setSaving] = useState(false);

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

  const targetCategory = target === "front" ? "server_front" : "server_rear";
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = library.filter((item) => item.category === targetCategory);
  const shown = candidates.filter((item) => terms.every((term) => `${item.name} ${item.source}`.toLowerCase().includes(term)));

  const pickTarget = (kind: "front" | "rear") => setTarget(kind);
  const mapKey = (kind: "front" | "rear") => `${kind}:${kind === "front" ? backplaneId : "rear"}`;
  /** 모달에서 고른 것: 저장하기 전까지는 미리보기만 (null = 자동으로 되돌리기) */
  const chosen = (kind: "front" | "rear") => {
    const entry = pending[mapKey(kind)];
    if (!entry) return { item: images?.[kind]?.item || null, auto: images?.[kind]?.auto ?? true, changed: false };
    const lib = entry.itemId ? library.find((item) => item.id === entry.itemId) : null;
    return { item: lib ? { id: lib.id, name: lib.name, url: `/static/${lib.file}` } : null, auto: !entry.itemId, changed: true };
  };
  const usedAs = (id: string) => [chosen("front").item?.id === id && "전면", chosen("rear").item?.id === id && "후면"].filter(Boolean).join("·");
  const stage = (kind: string, key: string, itemId: string | null) =>
    setPending((current) => ({ ...current, [`${kind}:${key}`]: { kind, key, itemId } }));
  const pendingCount = Object.keys(pending).length;
  const closeManager = () => {
    if (pendingCount && !window.confirm(`저장하지 않은 이미지 변경 ${pendingCount}건이 있습니다. 버리고 닫을까요?`)) return;
    setPending({});
    setManagerOpen(false);
  };
  const savePending = async () => {
    setSaving(true);
    try {
      for (const entry of Object.values(pending)) await setImageMap(server.id, entry.kind as "front" | "rear" | "component" | "drive" | "psu", entry.key, entry.itemId);
      setPending({});
      setImageError("");
      onImagesChange();
      setManagerOpen(false);
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const selectedBackplane = server.backplanes.find((item) => item.id === backplaneId) || server.backplanes[0];
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

  const updateImage = (kind: "front" | "rear", itemId: string) => stage(kind, kind === "front" ? backplaneId : "rear", itemId || null);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
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
          <div className="modal" role="dialog" aria-modal="true" aria-label="서버 이미지 선택">
            <div className="row between">
              <h3>서버 이미지 선택 · {server.vendor} {server.model}</h3>
              <button className="ico" aria-label="닫기" onClick={closeManager}>✕</button>
            </div>
            <div className="assign">
              {(["front", "rear"] as const).map((kind) => {
                const status: { item: ImageRef | null; auto: boolean; changed: boolean; stencil?: string } = { stencil: images?.[kind]?.stencil, ...chosen(kind) };
                const label = kind === "front" ? `전면 · ${selectedBackplane?.name}` : "후면";
                return (
                  <div
                    key={kind}
                    role="button"
                    tabIndex={0}
                    className={`assign-card ${target === kind ? "on" : ""}`}
                    onClick={() => pickTarget(kind)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") pickTarget(kind); }}
                  >
                    <div className="row between"><b>{label}</b>{status.changed ? <span className="tag tag-warn">저장 전</span> : status?.item && <span className="tag">{status.auto ? "자동 연결" : "직접 선택"}</span>}</div>
                    {status?.item
                      ? <img src={status.item.url} alt={`${label} 이미지`} />
                      : <div className="thumb-empty">이미지 없음 · 필요한 쉐이프: {status?.stencil || "-"}</div>}
                    <div className="row between">
                      <span className="small">{status?.item?.name || "미지정"}</span>
                      {status?.item && !status.auto && <button type="button" className="btn ghost small" onClick={(event) => { event.stopPropagation(); updateImage(kind, ""); }}>자동으로 되돌리기</button>}
                    </div>
                    <span className="assign-hint">{target === kind ? "아래 후보에서 클릭하면 바뀝니다" : "클릭해서 바꾸기"}</span>
                  </div>
                );
              })}
            </div>
            <div className="row between">
              <h4>{target === "front" ? "전면" : "후면"} 이미지 후보 <span className="muted small">{shown.length}개</span></h4>
              <input type="search" placeholder="이름 검색 (예: 16D, 3.5, 8xPCI)" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="이미지 검색" />
            </div>
            <div className="libgrid">
              {shown.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  title={`${item.name}\n${item.source}`}
                  className={`libcard pickable ${usedAs(item.id) ? "used" : ""}`}
                  onClick={() => updateImage(target, item.id)}
                >
                  {usedAs(item.id) && <em className="used-badge" title={`${usedAs(item.id)} 그림`}>✓ {pendingCount && chosen(target).item?.id === item.id && chosen(target).changed ? "선택됨" : "지금 적용됨"}</em>}
                  <img src={`/static/${item.file}`} alt="" loading="lazy" />
                  <span>{item.name}</span><small>{item.source}</small>
                </button>
              ))}
              {!shown.length && <p className="muted">{candidates.length ? "검색 조건에 맞는 이미지가 없습니다." : `${target === "front" ? "전면" : "후면"} 이미지가 아직 없습니다. 아래에서 스텐실을 올려주세요.`}</p>}
            </div>
            <div className="upload-foot">
              <span className="muted small">찾는 서버 이미지가 없나요?</span>
            <div className="row">
              <label className="btn">
                <input type="file" accept=".vssx,.vsdx,.vstx,.png,.jpg,.jpeg,.webp,.bmp,.gif" multiple hidden disabled={busy} onChange={handleUpload} />
                VSSX / VSDX / 이미지 업로드
              </label>
              <span className="muted">Dell 스텐실을 올리면 서버·디스크 이미지를 추출해 이름으로 자동 연결합니다.</span>
            </div>
            {!!uploadMessage && (
              <div className={`job ${!busy && uploadPercent === 100 ? "fin" : ""}`}>
                <div className="bar"><i style={{ width: `${uploadPercent}%` }} /></div><span>{uploadMessage}</span>
              </div>
            )}
            </div>
            <details className="sub">
              <summary>고급: 카드(OCP·NIC·FC·GPU) · 디스크 · PSU 이미지 연결 (전면/후면 합성에 쓰임)</summary>
              <div className="scroll">
                <table className="grid">
                  <thead><tr><th>부품</th><th>사용 이미지</th><th>연결</th></tr></thead>
                  <tbody>
                    {[...components].sort((a, b) => Number(b.form === "ocp") - Number(a.form === "ocp")).map((component) => {
                      const image = images?.components[component.id];
                      return (
                        <tr key={component.id}>
                          <td>{component.name}<span className="muted small"> · {component.category}</span></td>
                          <td>{image?.item?.name || (component.form === "ocp" ? "자동 이미지 없음" : "이미지 없음 — 글자 라벨로 표시")}{image?.auto === false ? " · 직접 선택" : ""}</td>
                          <td><select aria-label={`${component.name} 이미지`} value={pending[`component:${component.id}`] ? pending[`component:${component.id}`].itemId || "" : image?.item?.id || ""} onChange={(event) => stage("component", component.id, event.target.value || null)}>
                            <option value="">자동(스텐실 기본값)</option>
                            {library.filter((item) => component.form === "ocp" ? item.category === "ocp" : ["other", "module", "ocp"].includes(item.category)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select></td>
                        </tr>
                      );
                    })}
                    {server.psu_options.map((watt) => {
                      const image = images?.psus?.[String(watt)];
                      return (
                        <tr key={`psu-${watt}`}>
                          <td>PSU {watt}W</td>
                          <td>{image?.item ? `${image.item.name}${image.exact ? "" : " · 다른 용량 이미지로 대체 중"}` : "PSU 이미지 없음"}{image?.auto === false ? " · 직접 선택" : ""}</td>
                          <td><select aria-label={`PSU ${watt}W 이미지`} value={pending[`psu:${watt}`] ? pending[`psu:${watt}`].itemId || "" : image?.auto === false ? image.item?.id || "" : ""} onChange={(event) => stage("psu", String(watt), event.target.value || null)}>
                            <option value="">자동(이름의 W로 매칭)</option>
                            {library.filter((item) => item.category === "psu").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select></td>
                        </tr>
                      );
                    })}
                    {server.drive_options.flatMap((drive) => (drive.ff === "2.5" ? ["V", "H"] : ["V"]).map((orientation) => {
                      const key = `${drive.id}:${orientation}`;
                      const image = images?.drives[key];
                      return (
                        <tr key={key}>
                          <td>{drive.name}{drive.ff === "2.5" ? orientation === "V" ? " · 세로 베이" : " · 가로 베이" : ""}</td>
                          <td>{image?.item?.name || "자동 이미지 없음"}{image?.auto === false ? " · 직접 선택" : ""}</td>
                          <td><select aria-label={`${drive.name} 이미지`} value={pending[`drive:${key}`] ? pending[`drive:${key}`].itemId || "" : image?.item?.id || ""} onChange={(event) => stage("drive", key, event.target.value || null)}>
                            <option value="">자동(스텐실 기본값)</option>
                            {library.filter((item) => item.category === "drive").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select></td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
            </details>

            {imageError && <p className="warn" role="alert">{imageError}</p>}
            <div className="modal-foot">
              <span className="muted small">{pendingCount ? `바꾼 이미지 ${pendingCount}건 — 저장하면 서버 그림에 적용됩니다` : "바꾼 이미지가 없습니다"}</span>
              <button type="button" className="btn ghost" onClick={closeManager}>취소</button>
              <button type="button" className="btn" disabled={!pendingCount || saving} onClick={() => void savePending()}>{saving ? "저장 중…" : "저장하기"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
