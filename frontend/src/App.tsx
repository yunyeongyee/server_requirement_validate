import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyProposal,
  extractRequirements,
  getComponents,
  getImageStatus,
  getServers,
  redetectBays,
  renderServer,
  saveBays,
  saveHotspots,
  uploadRequirement,
  validateServer,
} from "./api";
import type { Component, ExtractionInfo, ImageStatus, ProjectSummary, Requirement, RequirementGroup, Server, ServerConfig, ValidationResult } from "./types";
import QuoteSection from "./components/QuoteSection";
import { ItemIcon } from "./components/ComparisonUI";
import ConfigSection from "./components/ConfigSection";
import RequirementSection from "./components/RequirementSection";
import ResultSection from "./components/ResultSection";
import ServerSection from "./components/ServerSection";

interface ServerProfile {
  serverId: string;
  config: ServerConfig;
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
  if (!statuses.length) return "미검증";
  if (statuses.includes("호환 불가")) return "구성 불가";
  if (statuses.includes("미충족")) return "미충족";
  if (statuses.includes("확인 필요")) return "확인 필요";
  return "충족";
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
  const [extractionInfo, setExtractionInfo] = useState<ExtractionInfo | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  const [imageError, setImageError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [validationBusy, setValidationBusy] = useState(false);
  const [renderedImages, setRenderedImages] = useState<{ front: string | null; rear: string | null }>({ front: null, rear: null });
  const [imageVersion, setImageVersion] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [apiRetry, setApiRetry] = useState(0);
  const [proposalNotes, setProposalNotes] = useState<Record<string, string[]>>({});
  const configurationEditor = useRef<HTMLDetailsElement>(null);
  const [quoteApplications, setQuoteApplications] = useState<Record<string, { at: string; notes: string[] }>>({});
  const [applyingGroupId, setApplyingGroupId] = useState<string | null>(null);

  const activeGroup = groups.find(item => item.id === activeGroupId) || groups[0];
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
          setProfiles({ [DEFAULT_GROUP_ID]: { serverId: serverList[0].id, config: defaultConfig(serverList[0]) } });
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
        if (active) setRenderedImages({ front: front.url, rear: rear.url });
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
      const serverId = group.suggested_server || existing?.serverId || (index === 0 ? server?.id : undefined) || defaultServer?.id;
      const selectedServer = servers.find((item) => item.id === serverId);
      if (selectedServer) {
        nextProfiles[group.id] = existing || { serverId: selectedServer.id, config: defaultConfig(selectedServer) };
      }
    });
    setGroups(normalized);
    setProfiles(nextProfiles);
    setProposalNotes({});
    setQuoteApplications({});
    setResults({});
    setActiveGroupId(normalized[0].id);
    setImageStatus(null);
    setRenderedImages({ front: null, rear: null });
  };

  const handleUpload = async (file: File) => {
    setUploadBusy(true);
    setUploadError("");
    setExtractionInfo(null);
    try {
      const response = await uploadRequirement(file);
      setDocumentName(response.filename);
      setDocumentText(response.text);
      setExtractionInfo(response.extraction || { mode: "rules" });
      installGroups(response.groups?.length ? response.groups : [{
        id: DEFAULT_GROUP_ID,
        name: "서버 1",
        requirements: response.requirements || [],
        spec: response.spec || [],
      }]);
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
      const response = await extractRequirements(text);
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
      setProfiles((current) => ({ ...current, [groupId]: { serverId: groupServer.id, config: nextConfig } }));
      setProposalNotes((current) => ({ ...current, [groupId]: notes }));
      setQuoteApplications(current => ({ ...current, [groupId]: { at: new Date().toISOString(), notes } }));
      setRenderedImages({ front: null, rear: null });
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplyingGroupId(null);
    }
  };

  const handleQuoteApply = async (quote: RequirementGroup) => {
    if (!quote.proposed || !server || !config) throw new Error("견적을 적용할 서버 구성이 없습니다.");
    const groupId = activeGroupId;
    const { config: nextConfig, notes } = await applyProposal(server.id, quote.proposed, config,
      quote.items?.find(item => item.category === "base")?.attrs || null);
    if (quote.model_hint && quote.model_hint.replace(/\s/g, "").toLowerCase() !== server.model.replace(/\s/g, "").toLowerCase()) {
      notes.unshift(`견적 모델 ${quote.model_hint}을 선택한 모델 ${server.model}에 반영했습니다. 부품 대체 및 호환성을 확인해 주세요.`);
    }
    setProfiles(current => ({ ...current, [groupId]: { serverId: server.id, config: nextConfig } }));
    setResults(current => { const next = { ...current }; delete next[groupId]; return next; });
    setQuoteApplications(current => ({ ...current, [groupId]: { at: new Date().toISOString(), notes } }));
    setRenderedImages({ front: null, rear: null });
  };
  const openConfiguration = (key?: string) => {
    if (!configurationEditor.current) return;
    configurationEditor.current.open = true;
    configurationEditor.current.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      const target = key?.startsWith("fc_") || key?.startsWith("nic_") || key === "ocp_required"
        ? configurationEditor.current?.querySelector<HTMLSelectElement>('[id^="slot-"]')
        : configurationEditor.current?.querySelector<HTMLSelectElement>("#s4 select");
      const details = target?.closest("details");
      if (details) details.open = true;
      target?.focus({ preventScroll: true });
    }, 100);
  };

  const handleRequirementsChange = (groupId: string, requirements: Requirement[]) => {
    setResults(current => { const next = { ...current }; delete next[groupId]; return next; });
    setGroups((current) => current.map((group) => group.id === groupId ? { ...group, requirements } : group));
  };

  const handleServerChange = (id: string) => {
    const nextServer = servers.find((item) => item.id === id);
    if (!nextServer) return;
    setProfiles((current) => ({ ...current, [activeGroupId]: { serverId: id, config: defaultConfig(nextServer) } }));
    setQuoteApplications(current => { const next = { ...current }; delete next[activeGroupId]; return next; });
    setResults((current) => {
      const next = { ...current };
      delete next[activeGroupId];
      return next;
    });
    setImageStatus(null);
    setRenderedImages({ front: null, rear: null });
  };

  const handleConfigChange = (nextConfig: ServerConfig) => {
    setResults(current => { const next = { ...current }; delete next[activeGroupId]; return next; });
    setProfiles((current) => {
      const currentProfile = current[activeGroupId];
      return currentProfile ? { ...current, [activeGroupId]: { ...currentProfile, config: nextConfig } } : current;
    });
  };

  const handleBackplaneChange = (id: string) => {
    if (!config || !server) return;
    const baysAvailable = server.backplanes.find((item) => item.id === id)?.bays || 0;
    const bays = Object.fromEntries(Object.entries(config.bays).filter(([index]) => Number(index) < baysAvailable));
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

  const allRequirementCount = groups.reduce((count, group) => count + group.requirements.length, 0);
  const headerText = documentName
    ? `${groups.length}개 서버 · 요구사항 ${allRequirementCount}개`
    : "";

  return (
    <>
      <header className="top">
        <div className="brand">
          <h1>Server Requirement Validator</h1>
          <p>고객 요구사항 문서 ↔ 실제 서버 구성 검증</p>
        </div>
        {headerText && <div className="verdict">{headerText}</div>}
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
        <main>
          <nav className="server-tabs workspace-tabs" aria-label="서버 선택">
            {groups.map(group => <button key={group.id} className={group.id === activeGroupId ? "on" : ""} onClick={() => setActiveGroupId(group.id)}>{group.name}{group.quantity ? ` · ${group.quantity}대` : ""}</button>)}
            <a className="lnk" href="#s6">전체 결과 ›</a>
          </nav>
          <div className="comparison-layout">
          <RequirementSection
            result={validation}
            validating={validationBusy}
            groups={groups}
            activeGroupId={activeGroupId}
            documentName={documentName}
            documentText={documentText}
            extractionInfo={extractionInfo}
            busy={uploadBusy}
            error={uploadError}
            onUpload={handleUpload}
            onSelectGroup={setActiveGroupId}
            onChange={handleRequirementsChange}
            onReExtract={handleReExtract}
            servers={servers}
            activeServer={server}
            proposalNotes={proposalNotes}
            applyingGroupId={applyingGroupId}
            onApplyProposal={(groupId) => void handleApplyProposal(groupId)}
          />
          <div className="comparison-right">
            <QuoteSection key={`${documentName}:${documentText}`} group={activeGroup} server={server} config={config} components={components}
              result={validation} validating={validationBusy} appliedAt={quoteApplications[activeGroupId]?.at}
              notes={quoteApplications[activeGroupId]?.notes} onApply={handleQuoteApply} onEdit={openConfiguration}>
              <section className="panel server-diagram">
                <h2><ItemIcon label="서버"/>서버 구성도</h2>
                {(["front", "rear"] as const).map(view => {
                  const url = renderedImages[view] || imageStatus?.[view].item?.url;
                  const bays = server?.backplanes.find(item => item.id === config?.backplane)?.bays || 0;
                  const usedDisks = Object.keys(config?.bays || {}).length;
                  const usedPCIe = server?.slots.filter(slot => slot.type === "pcie" && config?.slots[slot.id]).length || 0;
                  const usedOCP = server?.slots.filter(slot => slot.type === "ocp" && config?.slots[slot.id]).length || 0;
                  return <figure key={view} className="comparison-stage">
                    <figcaption>{view === "front" ? "Front · 서버 전면 그림" : "Rear · 서버 후면 그림"}</figcaption>
                    {url ? <img src={url} alt={`${server?.model || "서버"} ${view === "front" ? "전면" : "후면"} 구성`}/> : <p className="muted">{imageError || "서버 이미지를 준비하고 있습니다. 이미지가 없어도 구성을 편집할 수 있습니다."}</p>}
                    <p>{view === "front" ? `Disk 사용 ${usedDisks} / 여유 ${Math.max(0, bays - usedDisks)}` : `PCIe 사용 ${usedPCIe} / 여유 ${validation?.summary.free_pcie ?? "—"} · OCP 사용 ${usedOCP} · 예상 소비전력 ${validation?.summary.power_est_w ?? "—"}W`}</p>
                  </figure>;
                })}
                <button className="lnk" onClick={() => openConfiguration()}>서버 그림에서 구성 편집</button>
              </section>
            </QuoteSection>
            <details className="configuration-editor" ref={configurationEditor}>
              <summary>서버 모델 · 부품 · 이미지 편집</summary>
          <ServerSection
            servers={servers}
            components={components}
            server={server}
            apiReady={apiReady}
            backplaneId={config?.backplane || ""}
            images={imageStatus}
            error={imageError}
            onServerChange={handleServerChange}
            onBackplaneChange={handleBackplaneChange}
            onImagesChange={reloadImages}
          />
          <ConfigSection
            server={server}
            apiReady={apiReady}
            components={components}
            config={config}
            result={validation}
            images={imageStatus}
            renderedImages={renderedImages}
            onChange={handleConfigChange}
            onSaveCalibration={saveCalibration}
            onRedetectBays={redetect}
          />
            </details>
          </div>
          </div>
          <ResultSection
            server={server}
            result={validation}
            error={validationError}
            loading={validationBusy}
            projectSummaries={projectSummaries}
            activeGroupId={activeGroupId}
            onSelectGroup={setActiveGroupId}
          />
        </main>
      </div>
    </>
  );
}
