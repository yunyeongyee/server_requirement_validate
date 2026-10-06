import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { getImageJob, getLibrary, setImageMap, uploadImageLibrary } from "../api";
import type { Component, ImageStatus, LibraryImage, Server } from "../types";

interface Props {
  servers: Server[];
  components: Component[];
  server: Server | null;
  apiReady: boolean | null;
  backplaneId: string;
  images: ImageStatus | null;
  error: string;
  onServerChange: (id: string) => void;
  onBackplaneChange: (id: string) => void;
  onImagesChange: () => void;
}

export default function ServerSection({
  servers,
  components,
  server,
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

  return (
    <section id="s2" className="panel">
      <h2><span className="n">2</span>서버 모델 · 실제 이미지</h2>
      {error && <p className="warn" role="alert">{error}</p>}
      <div className="row">
        <label>모델{" "}
          <select value={server.id} onChange={(event) => onServerChange(event.target.value)}>
            {servers.map((item) => <option key={item.id} value={item.id}>{item.vendor} {item.family} {item.model}</option>)}
          </select>
        </label>
        <label>백플레인(전면){" "}
          <select value={selectedBackplane?.id || ""} onChange={(event) => onBackplaneChange(event.target.value)}>
            {server.backplanes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <details className="specbox">
          <summary>서버 사양 보기</summary>
          <dl className="specs">{serverSpec.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </details>
      </div>
      <div className="imgsrc">
        <div className="row">
          <label className="btn">
            <input type="file" accept=".vssx,.vsdx,.vstx,.png,.jpg,.jpeg,.webp,.bmp,.gif" multiple hidden disabled={busy} onChange={handleUpload} />
            VSSX / VSDX / 이미지 업로드
          </label>
          <span className="muted">Dell 스텐실을 올리면 서버·디스크 이미지를 추출하고 자동으로 연결합니다. 라이브러리 {images?.library_count || library.length}개</span>
        </div>
        {!!uploadMessage && (
          <div className={`job ${!busy && uploadPercent === 100 ? "fin" : ""}`}>
            <div className="bar"><i style={{ width: `${uploadPercent}%` }} /></div><span>{uploadMessage}</span>
          </div>
        )}
        <div className="mapline">
          {(["front", "rear"] as const).map((kind) => {
            const status = images?.[kind];
            const selectedId = status?.item?.id || "";
            return (
              <span className="mapitem" key={kind}>
                <b>{kind === "front" ? "전면" : "후면"}</b>{" "}
                {status?.item ? <><span>{status.item.name}</span> <span className="tag">{status.auto ? "자동" : "직접 선택"}</span></> : <span className="warn">이미지 없음</span>}
                <select
                  aria-label={`${kind === "front" ? "전면" : "후면"} 이미지 선택`}
                  value={selectedId}
                  onChange={(event) => void updateImage(kind, event.target.value)}
                >
                  <option value="">자동(스텐실 기본값)</option>
                  {library.filter((item) => item.category === (kind === "front" ? "server_front" : "server_rear")).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                {!status?.item && <span className="muted">필요한 쉐이프: {status?.stencil || "-"}</span>}
              </span>
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
        <details className="sub">
          <summary>이미지 라이브러리 ({library.length})</summary>
          <div className="pickgrid">
            {library.map((item) => (
              <div className="cand" key={item.id}>
                <span>{item.name}</span><small>{item.source}</small>
              </div>
            ))}
            {!library.length && <p className="muted">먼저 VSSX/VSDX 또는 이미지 파일을 업로드하세요.</p>}
          </div>
        </details>
        {imageError && <p className="warn" role="alert">{imageError}</p>}
      </div>
      <p className="muted small">현재 백플레인: {selectedBackplane?.name || "-"} · 실제 이미지가 없어도 서버 구성 및 호환성 검증은 가능합니다.</p>
    </section>
  );
}
