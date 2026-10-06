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
  groupName: string;
  apiReady: boolean | null;
  backplaneId: string;
  images: ImageStatus | null;
  error: string;
  onServerChange: (id: string) => void;
  onBackplaneChange: (id: string) => void;
  onImagesChange: () => void;
}

const LIB_TABS: Array<[string, string]> = [
  ["all", "전체"], ["server_front", "전면"], ["server_rear", "후면"], ["drive", "디스크"],
  ["ocp", "OCP·NIC"], ["psu", "PSU"], ["etc", "기타"],
];
const MAIN_CATEGORIES = new Set(["server_front", "server_rear", "drive", "ocp", "psu"]);

export default function ServerSection({
  servers,
  components,
  server,
  modelSource,
  modelHint,
  groupName,
  apiReady,
  backplaneId,
  images,
  error,
  onServerChange,
  onBackplaneChange,
  onImagesChange,
}: Props) {
  const [library, setLibrary] = useState<LibraryImage[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState("");
  const [managerOpen, setManagerOpen] = useState(false);
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<"front" | "rear" | null>(null);

  useEffect(() => {
    if (apiReady !== true) return;
    getLibrary()
      .then((items) => setLibrary(items))
      .catch((reason: unknown) => setImageError(reason instanceof Error ? reason.message : String(reason)));
  }, [apiReady, images?.library_count]);

  if (!server) return (
    <section id="s2" className="panel">
      <h2><span className="n">2</span>서버 모델 · 실제 이미지</h2>
      <p className="muted">{apiReady === false
        ? "API 연결 후 서버 모델, 이미지 라이브러리와 실제 이미지를 불러옵니다."
        : "서버 목록을 불러오는 중입니다."}</p>
    </section>
  );

  const tabOf = (category: string) => MAIN_CATEGORIES.has(category) ? category : "etc";
  const counts = library.reduce<Record<string, number>>((acc, item) => {
    acc.all = (acc.all || 0) + 1;
    acc[tabOf(item.category)] = (acc[tabOf(item.category)] || 0) + 1;
    return acc;
  }, {});
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = library.filter((item) => (tab === "all" || tabOf(item.category) === tab)
    && terms.every((term) => `${item.name} ${item.source}`.toLowerCase().includes(term)));

  const pickTarget = (kind: "front" | "rear") => {
    setTarget((current) => current === kind ? null : kind);
    setTab(kind === "front" ? "server_front" : "server_rear");
  };
  const assignable = (item: LibraryImage) => !!target && item.category === (target === "front" ? "server_front" : "server_rear");
  const usedAs = (id: string) => [images?.front.item?.id === id && "전면", images?.rear.item?.id === id && "후면"].filter(Boolean).join("·");

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

  const updateImage = async (kind: "front" | "rear", itemId: string) => {
    try {
      await setImageMap(server.id, kind, kind === "front" ? backplaneId : "rear", itemId || null);
      onImagesChange();
      setImageError("");
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    }
  };

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
    <section id="s2" className="panel">
      <h2><span className="n">2</span>서버 모델{groupName && <span className="muted small"> · {groupName}</span>}</h2>
      {error && <p className="warn" role="alert">{error}</p>}
      <div className="modelbar">
        <div className="modelpick">
          <label>모델{" "}
            <select value={server.id} onChange={(event) => onServerChange(event.target.value)}>
              {servers.map((item) => <option key={item.id} value={item.id}>{item.vendor} {item.family} {item.model}</option>)}
            </select>
          </label>
          {sourceTag}
          <label>백플레인(전면){" "}
            <select value={selectedBackplane?.id || ""} onChange={(event) => onBackplaneChange(event.target.value)}>
              {server.backplanes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn ghost small" onClick={() => setManagerOpen(true)}>⚙ 이미지 관리</button>
        </div>
        <div className="thumbs">
          {(["front", "rear"] as const).map((kind) => {
            const status = images?.[kind];
            return (
              <figure key={kind} className="thumb">
                {status?.item ? <img src={status.item.url} alt={`${server.model} ${kind === "front" ? "전면" : "후면"}`} /> : <div className="thumb-empty">이미지 없음</div>}
                <figcaption>{kind === "front" ? "전면" : "후면"} · {status?.item?.name || "미지정"}</figcaption>
              </figure>
            );
          })}
        </div>
      </div>
      <details className="specbox">
        <summary>서버 사양 보기</summary>
        <dl className="specs">{serverSpec.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </details>
      {imageError && !managerOpen && <p className="warn" role="alert">{imageError}</p>}

      {managerOpen && (
        <div className="modal-back" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setManagerOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="이미지 관리">
            <div className="row between">
              <h3>이미지 관리 · {server.vendor} {server.model}</h3>
              <button className="ico" aria-label="닫기" onClick={() => setManagerOpen(false)}>✕</button>
            </div>
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
            <div className="assign">
              {(["front", "rear"] as const).map((kind) => {
                const status = images?.[kind];
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
                    <div className="row between"><b>{label}</b>{status?.item && <span className="tag">{status.auto ? "자동 연결" : "직접 선택"}</span>}</div>
                    {status?.item
                      ? <img src={status.item.url} alt={`${label} 이미지`} />
                      : <div className="thumb-empty">이미지 없음 · 필요한 쉐이프: {status?.stencil || "-"}</div>}
                    <div className="row between">
                      <span className="small">{status?.item?.name || "미지정"}</span>
                      {status?.item && !status.auto && <button type="button" className="btn ghost small" onClick={(event) => { event.stopPropagation(); void updateImage(kind, ""); }}>자동으로 되돌리기</button>}
                    </div>
                    <span className="assign-hint">{target === kind ? "아래 라이브러리에서 바꿀 이미지를 클릭하세요" : "클릭해서 바꾸기"}</span>
                  </div>
                );
              })}
            </div>
            <details className="sub">
              <summary>부품 · 디스크 이미지 연결</summary>
              <div className="scroll">
                <table className="grid">
                  <thead><tr><th>부품</th><th>사용 이미지</th><th>연결</th></tr></thead>
                  <tbody>
                    {components.filter((component) => component.form === "ocp").map((component) => {
                      const image = images?.components[component.id];
                      return (
                        <tr key={component.id}>
                          <td>{component.name}</td>
                          <td>{image?.item?.name || "자동 이미지 없음"}{image?.auto === false ? " · 직접 선택" : ""}</td>
                          <td><select aria-label={`${component.name} 이미지`} value={image?.item?.id || ""} onChange={(event) => void setImageMap(server.id, "component", component.id, event.target.value || null).then(onImagesChange).catch((reason: unknown) => setImageError(reason instanceof Error ? reason.message : String(reason)))}>
                            <option value="">자동(스텐실 기본값)</option>
                            {library.filter((item) => item.category === "ocp").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
                          <td><select aria-label={`${drive.name} 이미지`} value={image?.item?.id || ""} onChange={(event) => void setImageMap(server.id, "drive", key, event.target.value || null).then(onImagesChange).catch((reason: unknown) => setImageError(reason instanceof Error ? reason.message : String(reason)))}>
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
            <h4>이미지 라이브러리 <span className="muted small">{shown.length}/{library.length}</span></h4>
            <div className="row">
              <div className="seg">
                {LIB_TABS.map(([key, label]) => (
                  <button type="button" key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>
                    {label} {counts[key] || 0}
                  </button>
                ))}
              </div>
              <input type="search" placeholder="이름·출처 검색 (예: R760, OCP, 3.5)" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="라이브러리 검색" />
            </div>
            <div className="libgrid">
              {shown.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  title={`${item.name}\n${item.source}`}
                  className={`libcard ${usedAs(item.id) ? "used" : ""} ${assignable(item) ? "pickable" : ""}`}
                  disabled={!!target && !assignable(item)}
                  onClick={() => { if (target && assignable(item)) void updateImage(target, item.id); }}
                >
                  {usedAs(item.id) && <em className="used-badge">{usedAs(item.id)} 사용 중</em>}
                  <img src={`/static/${item.file}`} alt="" loading="lazy" />
                  <span>{item.name}</span><small>{item.source}</small>
                </button>
              ))}
              {!shown.length && <p className="muted">{library.length ? "조건에 맞는 이미지가 없습니다." : "먼저 VSSX/VSDX 또는 이미지 파일을 업로드하세요."}</p>}
            </div>
            {imageError && <p className="warn" role="alert">{imageError}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
