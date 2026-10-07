import { useEffect, useMemo, useState } from "react";
import {
  applyProposal,
  extractRequirements,
  pasteText,
  getComponents,
  getImageStatus,
  getServers,
  listProjects,
  loadProject,
  saveProject,
  redetectBays,
  renderServer,
  saveBays,
  saveHotspots,
  setImageMap,
  uploadRequirement,
  validateServer,
} from "./api";
import type { Component, ExtractionInfo, InventoryRow, UploadResponse, ImageStatus, ProjectSummary, Requirement, RequirementGroup, Server, ServerConfig, ValidationResult } from "./types";
import type { SavedProject } from "./api";
import ConfigSection from "./components/ConfigSection";
import type { FocusRequest, RenderedImages } from "./components/ConfigSection";
import RequirementSection from "./components/RequirementSection";
import ResultSection from "./components/ResultSection";
import ServerSection from "./components/ServerSection";
import ServerBar from "./components/ServerBar";
import AiToggle from "./components/AiBadge";

export type ModelSource = "document" | "manual" | "default";

interface ServerProfile {
  serverId: string;
  config: ServerConfig;
  /** 모델을 어떻게 골랐는지: 문서에서 자동 / 사용자가 직접 / 문서에 없어 기본값 */
  source: ModelSource;
}

const DEFAULT_GROUP_ID = "server-1";


function defaultConfig(server: Server): ServerConfig {
  return {
    cpu_model: server.cpu_options[2] || server.cpu_options[0],
    cpu_count: server.cpu_sockets,
    memory: [{ size_gb: 64, qty: 8 }],
    backplane: server.backplanes[0].id,
    bays: {},
    raid: { boot: "RAID1", data: "RAID5" },
    boss: false,
    psu_watt: server.psu_options.includes(1400) ? 1400 : server.psu_options[server.psu_options.length - 1],
    psu_count: server.psu_bays,
    risers: server.risers.filter((riser) => riser.default).map((riser) => riser.id),
    slots: {},
  };
}

function verdictFor(result: ValidationResult | undefined): string {
  if (!result) return "미검증";
  const statuses = [
    ...result.requirements.map((item) => item.status),
    ...result.general.map((item) => item.status),
    ...result.slots.map((item) => item.status).filter((status): status is string => !!status && status !== "충족"),
    ...result.bays.map((item) => item.status).filter((status) => status !== "충족"),
  ];
  const noRequirements = !result.requirements.length;
  if (!statuses.length) return noRequirements ? "요구사항 없음" : "충족";
  if (statuses.includes("호환 불가")) return "구성 불가";
  if (statuses.includes("미충족")) return "미충족";
  if (statuses.includes("확인 필요")) return "확인 필요";
  // 요구사항이 없는 견적 그룹은 구성 호환성만 본 것이므로 '충족'으로 표시하지 않는다
  return noRequirements ? "구성 정상 · 요구사항 없음" : "충족";
}

function makeSummaries(
  groups: RequirementGroup[],
  profiles: Record<string, ServerProfile>,
  servers: Server[],
  results: Record<string, ValidationResult>,
): ProjectSummary[] {
  return groups.map((group) => {
    const result = results[group.id];
    const server = servers.find((item) => item.id === profiles[group.id]?.serverId);
    return {
      id: group.id,
      name: group.name,
      model: server ? `${server.vendor} ${server.model}` : "-",
      matched: result?.requirements.filter((item) => item.status === "충족").length || 0,
      failed: result?.requirements.filter((item) => item.status === "미충족" || item.status === "호환 불가").length || 0,
      review: group.requirements.filter((item) => item.status === "review").length
        + (result?.requirements.filter((item) => item.status === "확인 필요").length || 0),
      verdict: verdictFor(result),
    };
  });
}

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [groups, setGroups] = useState<RequirementGroup[]>([
    { id: DEFAULT_GROUP_ID, name: "서버 1", requirements: [], spec: [] },
  ]);
  const [activeGroupId, setActiveGroupId] = useState(DEFAULT_GROUP_ID);
  const [profiles, setProfiles] = useState<Record<string, ServerProfile>>({});
  const [results, setResults] = useState<Record<string, ValidationResult>>({});
  const [documentName, setDocumentName] = useState("");
  const [documentText, setDocumentText] = useState("");
  /** 저장 이름 (문서 이름, 붙여넣기는 시각을 붙임) · 마지막으로 저장한 내용과 시각 */
  const [projectName, setProjectName] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [extractionInfo, setExtractionInfo] = useState<ExtractionInfo | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  const [imageError, setImageError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [validationBusy, setValidationBusy] = useState(false);
  const [renderedImages, setRenderedImages] = useState<RenderedImages>({ front: null, rear: null });
  const [imageVersion, setImageVersion] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [apiRetry, setApiRetry] = useState(0);
  const [proposalNotes, setProposalNotes] = useState<Record<string, string[]>>({});
  const [applyingGroupId, setApplyingGroupId] = useState<string | null>(null);
  const [view, setView] = useState<"server" | "all">("server");
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [aiOn, setAiOn] = useState(() => { try { return localStorage.getItem("srv.ai") === "1"; } catch { return false; } });
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [documentSignal, setDocumentSignal] = useState(0);
  const [pickFileSignal, setPickFileSignal] = useState(0);
  const [imagesSignal, setImagesSignal] = useState(0);
  const [pasteSignal, setPasteSignal] = useState(0);

  const profile = profiles[activeGroupId];
  const server = useMemo(
    () => servers.find((item) => item.id === profile?.serverId) || null,
    [servers, profile?.serverId],
  );
  const config = profile?.config || null;
  const validation = results[activeGroupId] || null;
  const projectSummaries = useMemo(() => makeSummaries(groups, profiles, servers, results), [groups, profiles, servers, results]);

  useEffect(() => {
    let active = true;
    Promise.all([getServers(), getComponents()])
      .then(([serverList, componentList]) => {
        if (!active) return;
        setServers(serverList);
        setComponents(componentList);
        setApiReady(true);
        setLoadError("");
        if (serverList.length) {
          setProfiles({ [DEFAULT_GROUP_ID]: { serverId: serverList[0].id, config: defaultConfig(serverList[0]), source: "default" } });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setApiReady(false);
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => { active = false; };
  }, [apiRetry]);

  // 모든 요구 서버를 검증해 프로젝트 결과표가 '미검증'으로 남지 않게 한다
  useEffect(() => {
    if (!servers.length) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setValidationBusy(true);
      Promise.all(groups.map(async (group) => {
        const groupProfile = profiles[group.id];
        const groupServer = servers.find((item) => item.id === groupProfile?.serverId);
        if (!groupProfile || !groupServer) return null;
        const result = await validateServer(groupServer.id, groupProfile.config,
          group.requirements.filter((item) => !item._new && item.status !== "review"));
        return [group.id, result] as const;
      }))
        .then((pairs) => {
          if (!active) return;
          setResults(Object.fromEntries(pairs.filter((pair): pair is readonly [string, ValidationResult] => !!pair)));
          setValidationError("");
        })
        .catch((reason: unknown) => {
          if (active) setValidationError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => { if (active) setValidationBusy(false); });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [servers, groups, profiles]);

  useEffect(() => {
    if (!server || !config) return;
    let active = true;
    getImageStatus(server.id, config.backplane)
      .then((status) => {
        if (active) {
          setImageStatus(status);
          setImageError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setImageError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [server, config?.backplane, imageVersion]);

  useEffect(() => {
    if (!server || !config) return;
    let active = true;
    const timer = window.setTimeout(() => {
      Promise.all([
        renderServer(server.id, "front", config),
        renderServer(server.id, "rear", config),
      ]).then(([front, rear]) => {
        // 새 그림을 미리 받아 둔 뒤 바꿔야 깜빡이지 않는다
        const preload = (url: string | null) => new Promise<void>((resolve) => {
          if (!url) return resolve();
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = url;
        });
        return Promise.all([preload(front.url), preload(rear.url)]).then(() => {
          if (active) setRenderedImages({ front: front.url, rear: rear.url, config });
        });
      }).catch((reason: unknown) => {
        if (active) setImageError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [server, config, imageVersion]);

  const installGroups = (nextGroups: RequirementGroup[]) => {
    const normalized = nextGroups.length
      ? nextGroups
      : [{ id: DEFAULT_GROUP_ID, name: "서버 1", requirements: [], spec: [] }];
    const defaultServer = servers[0];
    const nextProfiles: Record<string, ServerProfile> = {};
    normalized.forEach((group, index) => {
      const existing = profiles[group.id];
      const suggested = servers.find((item) => item.id === group.suggested_server);
      // 문서에서 찾은 모델이 있으면 그것을 우선. 사용자가 직접 고른 모델은 같은 그룹이면 유지.
      if (existing?.source === "manual" && (!suggested || existing.serverId === suggested.id)) {
        nextProfiles[group.id] = existing;
        return;
      }
      if (suggested) {
        nextProfiles[group.id] = existing?.serverId === suggested.id
          ? { ...existing, source: "document" }
          : { serverId: suggested.id, config: defaultConfig(suggested), source: "document" };
        return;
      }
      const fallback = servers.find((item) => item.id === (existing?.serverId || (index === 0 ? server?.id : undefined))) || defaultServer;
      if (fallback) {
        nextProfiles[group.id] = existing?.serverId === fallback.id
          ? { ...existing, source: "default" }
          : { serverId: fallback.id, config: defaultConfig(fallback), source: "default" };
      }
    });
    setGroups(normalized);
    setProfiles(nextProfiles);
    setProposalNotes({});
    setResults({});
    setActiveGroupId(normalized[0].id);
    // 서버·백플레인이 그대로면 이미지 effect 가 다시 돌지 않으므로 상태를 지우지 말고 다시 불러온다
    setImageVersion((version) => version + 1);
    setView("server");
    return { normalized, nextProfiles };
  };

  /** 견적서 그룹은 업로드 직후 제안 구성을 자동으로 적용한다 */
  const autoApply = async (nextGroups: RequirementGroup[], nextProfiles: Record<string, ServerProfile>) => {
    const quoteGroups = nextGroups.filter((group) => group.proposed && nextProfiles[group.id]);
    if (!quoteGroups.length) return;
    const applied = await Promise.all(quoteGroups.map(async (group) => {
      const groupProfile = nextProfiles[group.id];
      const base = group.items?.find((item) => item.category === "base");
      try {
        const { config: nextConfig, notes } = await applyProposal(groupProfile.serverId, group.proposed!, groupProfile.config, base?.attrs || null);
        return [group.id, groupProfile, nextConfig, notes] as const;
      } catch {
        return null;
      }
    }));
    setProfiles((current) => {
      const next = { ...current };
      applied.forEach((entry) => { if (entry) next[entry[0]] = { ...entry[1], config: entry[2] }; });
      return next;
    });
    setProposalNotes((current) => {
      const next = { ...current };
      applied.forEach((entry) => { if (entry) next[entry[0]] = entry[3]; });
      return next;
    });
  };

  /** 저장 대상: 문서 분석 결과와 서버별 구성 전체 (검증 결과·그림은 다시 계산) */
  const snapshot = useMemo(() => JSON.stringify({
    documentName, documentText, extractionInfo, groups, profiles, activeGroupId, inventory, proposalNotes,
  }), [documentName, documentText, extractionInfo, groups, profiles, activeGroupId, inventory, proposalNotes]);
  const dirty = !!documentName && snapshot !== savedSnapshot;

  const handleSave = async () => {
    if (!documentName) return;
    setSaveBusy(true);
    setSaveError("");
    try {
      const saved = await saveProject(projectName || documentName, JSON.parse(snapshot));
      setSavedSnapshot(snapshot);
      setSavedAt(saved.saved_at);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleOpenProject = async (id: string) => {
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 버리고 저장한 작업을 열까요?")) return;
    try {
      const project = await loadProject<{
        documentName: string; documentText: string; extractionInfo: ExtractionInfo | null; groups: RequirementGroup[];
        profiles: Record<string, ServerProfile>; activeGroupId: string; inventory: InventoryRow[]; proposalNotes: Record<string, string[]>;
      }>(id);
      const state = project.state;
      setDocumentName(state.documentName);
      setDocumentText(state.documentText || "");
      setExtractionInfo(state.extractionInfo || null);
      setGroups(state.groups);
      setProfiles(state.profiles);
      setActiveGroupId(state.groups.some((group) => group.id === state.activeGroupId) ? state.activeGroupId : state.groups[0]?.id || DEFAULT_GROUP_ID);
      setInventory(state.inventory || []);
      setProposalNotes(state.proposalNotes || {});
      setResults({});
      setRenderedImages({ front: null, rear: null });
      setView("server");
      setProjectName(project.name);
      setSavedAt(project.saved_at);
      // 저장 당시 내용과 같게 맞춰 '저장 안 됨'으로 보이지 않게
      setSavedSnapshot(JSON.stringify({
        documentName: state.documentName, documentText: state.documentText || "", extractionInfo: state.extractionInfo || null,
        groups: state.groups, profiles: state.profiles,
        activeGroupId: state.groups.some((group) => group.id === state.activeGroupId) ? state.activeGroupId : state.groups[0]?.id || DEFAULT_GROUP_ID,
        inventory: state.inventory || [], proposalNotes: state.proposalNotes || {},
      }));
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // 첫 화면에 '저장한 작업' 목록
  useEffect(() => {
    if (!apiReady || documentName) return;
    listProjects().then(setSavedProjects).catch(() => setSavedProjects([]));
  }, [apiReady, documentName]);
  // 저장하지 않고 창을 닫으려 하면 묻는다
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const handleUpload = (file: File) => analyze(() => uploadRequirement(file, aiOn));
  const handlePaste = (text: string) => analyze(() => pasteText(text, aiOn));

  /** 파일 업로드와 붙여넣기 공통: 분석 결과를 서버 그룹·구성에 반영 */
  const analyze = async (run: () => Promise<UploadResponse>) => {
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 버리고 새 문서를 분석할까요?")) return;
    setUploadBusy(true);
    setUploadError("");
    setExtractionInfo(null);
    try {
      const response = await run();
      const pasted = response.filename === "붙여넣기.tsv";
      setDocumentName(pasted ? "붙여넣은 내용" : response.filename);
      setProjectName(pasted ? `붙여넣은 내용 ${new Date().toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : response.filename);
      setSavedSnapshot("");
      setSavedAt("");
      setDocumentText(response.text);
      setInventory(response.inventory || []);
      setExtractionInfo(response.extraction || { mode: "rules" });
      const installed = installGroups(response.groups?.length ? response.groups : [{
        id: DEFAULT_GROUP_ID,
        name: "서버 1",
        requirements: response.requirements || [],
        spec: response.spec || [],
      }]);
      await autoApply(installed.normalized, installed.nextProfiles);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploadBusy(false);
    }
  };

  const handleReExtract = async (text: string) => {
    setDocumentText(text);
    setUploadError("");
    try {
      const response = await extractRequirements(text, aiOn);
      setExtractionInfo(response.extraction || { mode: "rules" });
      installGroups(response.groups?.length ? response.groups : [{
        id: DEFAULT_GROUP_ID,
        name: "서버 1",
        requirements: response.requirements || [],
        spec: response.spec || [],
      }]);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleApplyProposal = async (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    const groupProfile = profiles[groupId];
    const groupServer = servers.find((item) => item.id === groupProfile?.serverId);
    if (!group?.proposed || !groupProfile || !groupServer) return;
    const base = group.items?.find((item) => item.category === "base");
    setApplyingGroupId(groupId);
    try {
      const { config: nextConfig, notes } = await applyProposal(groupServer.id, group.proposed, groupProfile.config, base?.attrs || null);
      setProfiles((current) => ({ ...current, [groupId]: { ...groupProfile, serverId: groupServer.id, config: nextConfig } }));
      setProposalNotes((current) => ({ ...current, [groupId]: notes }));
      setRenderedImages({ front: null, rear: null });
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplyingGroupId(null);
    }
  };

  /** 납품 목록 항목과 연결: 수량을 그 항목 수량으로 */
  const handleInventoryLink = (groupId: string, row: InventoryRow | null) => {
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, inventory_link: row?.name || null, quantity: row ? row.qty : null }
      : group));
  };

  const handleRequirementsChange = (groupId: string, requirements: Requirement[]) => {
    setGroups((current) => current.map((group) => group.id === groupId ? { ...group, requirements } : group));
  };

  const handleServerChange = (id: string) => {
    const nextServer = servers.find((item) => item.id === id);
    if (!nextServer) return;
    setProfiles((current) => ({ ...current, [activeGroupId]: { serverId: id, config: defaultConfig(nextServer), source: "manual" } }));
    setResults((current) => {
      const next = { ...current };
      delete next[activeGroupId];
      return next;
    });
    setImageStatus(null);
    setRenderedImages({ front: null, rear: null });
  };

  const handleConfigChange = (nextConfig: ServerConfig) => {
    setProfiles((current) => {
      const currentProfile = current[activeGroupId];
      return currentProfile ? { ...current, [activeGroupId]: { ...currentProfile, config: nextConfig } } : current;
    });
  };

  const handleBackplaneChange = (id: string) => {
    if (!config || !server) return;
    const next = server.backplanes.find((item) => item.id === id);
    const baysAvailable = next?.bays || 0;
    // 베이 수를 넘거나 규격(2.5"/3.5")이 맞지 않는 디스크는 뺀다
    const bays = Object.fromEntries(Object.entries(config.bays).filter(([index, bay]) => Number(index) < baysAvailable
      && server.drive_options.find((drive) => drive.id === bay.drive)?.ff === next?.ff));
    handleConfigChange({ ...config, backplane: id, bays });
    setRenderedImages({ front: null, rear: null });
  };

  const reloadImages = () => {
    if (server && config) setImageVersion((version) => version + 1);
  };

  const saveCalibration = async (
    hotspots: Record<string, { x: number; y: number; w: number; h: number }>,
    rects: Array<{ x: number; y: number; w: number; h: number }>,
  ) => {
    if (!server || !config) return;
    const updatedServer = {
      ...server,
      slots: server.slots.map((slot) => ({ ...slot, hotspot: hotspots[slot.id] || slot.hotspot })),
      psu_slots: server.psu_slots?.map((psu) => ({ ...psu, hotspot: hotspots[psu.id] || psu.hotspot })),
      rear_blocked: Object.entries(hotspots).filter(([key]) => key.startsWith("blk:"))
        .sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)))
        .map(([, area]) => ({ x: area.x, y: area.y, w: area.w, h: area.h, reason: (area as { reason?: string }).reason || "" })),
    };
    await saveHotspots(server.id, hotspots);
    await saveBays(server.id, config.backplane, rects);
    setServers((current) => current.map((item) => item.id === updatedServer.id ? updatedServer : item));
    setImageVersion((version) => version + 1);
  };

  const redetect = async () => {
    if (!server || !config) return;
    await redetectBays(server.id, config.backplane);
    setImageVersion((version) => version + 1);
  };


  return (
    <>
      <header className="top">
        <div className="brand">
          <h1>Server Requirement Validator</h1>
          <p>고객 요구사항 문서 ↔ 실제 서버 구성 검증</p>
        </div>
        <AiToggle on={aiOn} onChange={(next) => { setAiOn(next); try { localStorage.setItem("srv.ai", next ? "1" : "0"); } catch { /* 저장 불가 환경 */ } }} usedOnDocument={!!documentName && extractionInfo?.mode === "ai"} />
        {documentName && (
          <div className="docline">
            <b>{documentName}</b>
            <span>서버 {groups.length}종 · {groups.reduce((total, group) => total + (group.quantity || 1), 0)}대</span>
            {groups.some((group) => group.proposed) && <span className="muted-on-dark">{groups.some((group) => group.doc_role === "config") ? "구성도" : "견적"} 구성 자동 적용</span>}
            <button type="button" className="ghost-on-dark" onClick={() => setDocumentSignal((n) => n + 1)}>원문</button>
            <button type="button" className="ghost-on-dark" onClick={() => setPickFileSignal((n) => n + 1)}>다른 문서</button>
            <button type="button" className="ghost-on-dark" onClick={() => setPasteSignal((n) => n + 1)}>붙여넣기</button>
          </div>
        )}
        {documentName && <ServerBar groups={groups} summaries={projectSummaries} activeGroupId={activeGroupId} view={view} onSelect={(id) => { setActiveGroupId(id); setView("server"); }} onShowAll={() => setView("all")} />}
      </header>
      {apiReady === false && (
        <div className="stale offline-banner" role="status">
          <span>백엔드 API에 연결되지 않았습니다. 화면은 볼 수 있지만 문서 분석, 서버 카탈로그, 이미지 및 검증 기능은 API 연결 후 사용할 수 있습니다.</span>
          <button className="btn ghost small" onClick={() => { setApiReady(null); setApiRetry((attempt) => attempt + 1); }}>다시 연결</button>
          {loadError && <small role="alert">{loadError}</small>}
        </div>
      )}
      {apiReady === null && <div className="stale" role="status">백엔드 API에 연결하는 중입니다…</div>}
      <div className="layout">
        <main className={documentName && view === "server" ? "work" : ""}>
          {!documentName && savedProjects.length > 0 && (
            <section className="card saved" aria-label="저장한 작업">
              <h3>저장한 작업 이어서 하기</h3>
              <ul>
                {savedProjects.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <button type="button" className="saved-row" onClick={() => void handleOpenProject(item.id)}>
                      <b>{item.name}</b>
                      <span className="muted">서버 {item.servers}종 · {formatSavedAt(item.saved_at)} 저장</span>
                      <span className="lnk">열기</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view === "server" && <RequirementSection
            result={validation}
            onFocus={(request) => setFocus({ ...request, n: Date.now() })}
            showDocumentSignal={documentSignal}
            pickFileSignal={pickFileSignal}
            pasteSignal={pasteSignal}
            onPaste={(text) => void handlePaste(text)}
            inventory={inventory}
            onInventoryLink={handleInventoryLink}
            groups={groups}
            activeGroupId={activeGroupId}
            documentName={documentName}
            documentText={documentText}
            extractionInfo={extractionInfo}
            busy={uploadBusy}
            error={uploadError}
            onUpload={handleUpload}
            onChange={handleRequirementsChange}
            onReExtract={handleReExtract}
            servers={servers}
            activeServer={server}
            proposalNotes={proposalNotes}
            applyingGroupId={applyingGroupId}
            onApplyProposal={(groupId) => void handleApplyProposal(groupId)}
          />}
          {documentName && view === "server" && <ConfigSection
            key={`${documentName}:${activeGroupId}`}
            modelLine={<ServerSection
            servers={servers}
            components={components}
            server={server}
            modelSource={profile?.source || "default"}
            modelHint={groups.find((group) => group.id === activeGroupId)?.model_hint || null}
            apiReady={apiReady}
            backplaneId={config?.backplane || ""}
            images={imageStatus}
            error={imageError}
            onServerChange={handleServerChange}
            onBackplaneChange={handleBackplaneChange}
            onImagesChange={reloadImages}
            openImagesSignal={imagesSignal}
          />}
            focus={focus}
            onOpenImages={() => setImagesSignal((n) => n + 1)}
            onUseAutoFront={async () => {
              if (!server || !config) return;
              await setImageMap(server.id, "front", config.backplane, null);
              reloadImages();
            }}
            server={server}
            apiReady={apiReady}
            components={components}
            config={config}
            result={validation}
            images={imageStatus}
            renderedImages={renderedImages}
            onChange={handleConfigChange}
            onBackplaneChange={handleBackplaneChange}
            onSaveCalibration={saveCalibration}
            onRedetectBays={redetect}
          />}
          {documentName && view === "all" && <ResultSection
            server={server}
            result={validation}
            error={validationError}
            loading={validationBusy}
            projectSummaries={projectSummaries}
            activeGroupId={activeGroupId}
            onSelectGroup={(id) => { setActiveGroupId(id); setView("server"); }}
          />}
          {documentName && (
            <div className={`savebar ${dirty ? "dirty" : ""}`} role="region" aria-label="저장">
              <span className="savebar-msg">
                {saveError ? <span className="warn">저장 오류: {saveError}</span>
                  : dirty ? <><i className="dot" aria-hidden="true" /> 저장하지 않은 변경이 있습니다</>
                  : <>✓ 저장됨 · {formatSavedAt(savedAt)}</>}
                <span className="muted small"> — {projectName || documentName}</span>
              </span>
              <button type="button" className="btn" disabled={saveBusy || !dirty} onClick={() => void handleSave()}>{saveBusy ? "저장 중…" : "저장하기"}</button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

/** "2026-10-07T14:32:05" → "10/07 14:32" */
function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
