import { useEffect, useMemo, useState } from "react";
import {
  applyProposal,
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
  validateServer,
} from "./api";
import type { Component, ImageStatus, ProjectSummary, Requirement, RequirementGroup, Server, ServerConfig, ValidationResult } from "./types";
import type { SavedProject } from "./api";
import ConfigSection from "./components/ConfigSection";
import type { FocusRequest, RenderedImages } from "./components/ConfigSection";
import RequirementSection from "./components/RequirementSection";
import ResultSection from "./components/ResultSection";
import ServerSection from "./components/ServerSection";
import ServerBar from "./components/ServerBar";
import QuotePanel from "./components/QuotePanel";
import { configDiff } from "./configDiff";

export type ModelSource = "document" | "manual" | "default";

interface ServerProfile {
  serverId: string;
  config: ServerConfig;
  /** 모델을 어떻게 골랐는지: 문서에서 자동 / 사용자가 직접 / 문서에 없어 기본값 */
  source: ModelSource;
}

const DEFAULT_GROUP_ID = "server-1";
const emptyGroup = (id: string, name: string): RequirementGroup => ({ id, name, requirements: [], spec: [] });
const stamp = () => formatSavedAt(new Date().toISOString());
const newGroupId = () => `server-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** 아직 아무것도 넣지 않은 탭 */
const isBlank = (group: RequirementGroup) => !group.text && !group.requirements.length && !group.quote;

interface SavedState {
  workName?: string;
  groups: RequirementGroup[];
  profiles: Record<string, ServerProfile>;
  activeGroupId: string;
  proposalNotes?: Record<string, string[]>;
}


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
  const [groups, setGroups] = useState<RequirementGroup[]>([emptyGroup(DEFAULT_GROUP_ID, "서버 1")]);
  const [activeGroupId, setActiveGroupId] = useState(DEFAULT_GROUP_ID);
  const [profiles, setProfiles] = useState<Record<string, ServerProfile>>({});
  const [results, setResults] = useState<Record<string, ValidationResult>>({});
  /** 작업 이름(저장 이름) · 마지막으로 저장한 내용과 시각 */
  const [workName, setWorkName] = useState(() => `새 작업 ${stamp()}`);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [openMenu, setOpenMenu] = useState(false);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState("");
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
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [imagesSignal, setImagesSignal] = useState(0);

  const group = groups.find((item) => item.id === activeGroupId) || groups[0];
  const profile = profiles[group.id];
  const server = useMemo(
    () => servers.find((item) => item.id === profile?.serverId) || null,
    [servers, profile?.serverId],
  );
  const config = profile?.config || null;
  const validation = results[group.id] || null;
  const diff = useMemo(() => group.quote ? configDiff(group.quote_config, config) : null, [group.quote, group.quote_config, config]);
  const projectSummaries = useMemo(() => makeSummaries(groups, profiles, servers, results), [groups, profiles, servers, results]);
  const defaultProfile = (): ServerProfile | null => servers[0] ? { serverId: servers[0].id, config: defaultConfig(servers[0]), source: "default" } : null;

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
          // 아직 모델이 없는 서버 탭에 기본 모델
          setProfiles((current) => {
            const next = { ...current };
            groups.forEach((item) => { if (!next[item.id]) next[item.id] = { serverId: serverList[0].id, config: defaultConfig(serverList[0]), source: "default" }; });
            return next;
          });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setApiReady(false);
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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


  /** 붙여넣기 분석 결과의 추천 모델 → 그 서버 탭의 모델 (사용자가 직접 고른 모델은 유지) */
  const profileFor = (next: RequirementGroup, existing: ServerProfile | undefined): ServerProfile | null => {
    const suggested = servers.find((item) => item.id === next.suggested_server);
    if (existing?.source === "manual" && existing) return existing;
    if (suggested) return existing?.serverId === suggested.id ? { ...existing, source: "document" } : { serverId: suggested.id, config: defaultConfig(suggested), source: "document" };
    return existing || defaultProfile();
  };

  /** 견적의 제안 구성을 그 서버 구성에 적용하고, 그 결과를 '견적 기준 구성'으로 기억 */
  const applyQuote = async (groupId: string, quote: RequirementGroup | undefined, targetProfile: ServerProfile | null) => {
    if (!quote?.proposed || !targetProfile) return;
    const base = quote.items?.find((item) => item.category === "base");
    try {
      const { config: nextConfig, notes } = await applyProposal(targetProfile.serverId, quote.proposed, targetProfile.config, base?.attrs || null);
      setProfiles((current) => ({ ...current, [groupId]: { ...(current[groupId] || targetProfile), config: nextConfig } }));
      setGroups((current) => current.map((item) => item.id === groupId ? { ...item, quote_config: nextConfig } : item));
      setProposalNotes((current) => ({ ...current, [groupId]: notes }));
    } catch (reason) {
      setQuoteError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /** 왼쪽 칸: 요구사항 붙여넣기. replace = 교체, append = 지금 내용 뒤에 붙여 다시 분석. 견적·구성은 건드리지 않는다 */
  const handlePaste = async (text: string, mode: "replace" | "append") => {
    const target = group;
    const fullText = mode === "append" && target.text ? `${target.text}\n${text}` : text;
    setPasteBusy(true);
    setPasteError("");
    try {
      const response = await pasteText(fullText, "requirement");
      const analyzed = response.server;
      // 사용자가 직접 고치거나 추가한 항목은 남긴다 (줄 번호는 append 라 그대로 유효)
      const kept = mode === "append" ? target.requirements.filter((item) => item._user) : [];
      const next: RequirementGroup = {
        ...target,
        text: analyzed.text, lines: analyzed.lines, spec: analyzed.spec,
        requirements: [...analyzed.requirements, ...kept],
        model_hint: target.model_hint || analyzed.model_hint, suggested_server: target.suggested_server || analyzed.suggested_server,
        line_marks: mode === "append" ? target.line_marks : {},
        split: response.split.length > 1 ? response.split : undefined,
        common_lines: response.common_lines,
      };
      setGroups((current) => current.map((item) => item.id === target.id ? next : item));
      // 견적이 아직 없을 때만 요구사항에 적힌 모델(R760 등)로 모델을 고른다
      if (!target.quote) {
        const nextProfile = profileFor(next, profiles[target.id]);
        if (nextProfile && nextProfile.serverId !== profiles[target.id]?.serverId) setProfiles((current) => ({ ...current, [target.id]: nextProfile }));
      }
    } catch (reason) {
      setPasteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPasteBusy(false);
    }
  };

  /** 오른쪽 칸: 견적 붙여넣기 → 견적 모델로 모델 선택 → 그림에 장착 */
  const handleQuotePaste = async (text: string) => {
    const target = group;
    setQuoteBusy(true);
    setQuoteError("");
    try {
      const response = await pasteText(text, "quote");
      const quote: RequirementGroup = { ...response.server, split: response.split.length > 1 ? response.split : undefined, line_marks: {} };
      const existing = profiles[target.id];
      const nextProfile = profileFor(quote, existing?.source === "manual" ? existing : existing && { ...existing, source: "default" });
      setGroups((current) => current.map((item) => item.id === target.id
        ? { ...item, quote, quantity: item.quantity ?? quote.quantity ?? null } : item));
      if (nextProfile) setProfiles((current) => ({ ...current, [target.id]: nextProfile }));
      setRenderedImages({ front: null, rear: null });
      setImageVersion((version) => version + 1);
      await applyQuote(target.id, quote, nextProfile);
    } catch (reason) {
      setQuoteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setQuoteBusy(false);
    }
  };
  const handleClearQuote = () => {
    setGroups((current) => current.map((item) => item.id === group.id ? { ...item, quote: undefined, quote_config: undefined } : item));
    setProposalNotes((current) => { const copy = { ...current }; delete copy[group.id]; return copy; });
  };
  const handleQuoteMark = (line: number, mark: "skip" | null) =>
    setGroups((current) => current.map((item) => {
      if (item.id !== group.id || !item.quote) return item;
      const marks = { ...(item.quote.line_marks || {}) };
      if (mark) marks[line] = mark; else delete marks[line];
      return { ...item, quote: { ...item.quote, line_marks: marks } };
    }));

  /** 요구사항 나누기 제안 수락: 지금 탭을 서버별 탭으로 (견적이 있었다면 첫 탭에 남긴다) */
  const handleSplit = () => {
    const parts = group.split || [];
    if (!parts.length) return;
    const made = parts.map((part, index) => ({
      ...part, id: newGroupId(), split: undefined, line_marks: {},
      ...(index === 0 && group.quote ? { quote: group.quote, quote_config: group.quote_config } : {}),
    }));
    const madeProfiles = Object.fromEntries(made.map((part, index) => [part.id,
      index === 0 && group.quote && profile ? profile : profileFor(part, undefined)]).filter(([, value]) => value)) as Record<string, ServerProfile>;
    setGroups((current) => current.flatMap((item) => item.id === group.id ? made : [item]));
    setProfiles((current) => { const next = { ...current, ...madeProfiles }; delete next[group.id]; return next; });
    if (group.quote && proposalNotes[group.id]) setProposalNotes((current) => ({ ...current, [made[0].id]: current[group.id] }));
    setActiveGroupId(made[0].id);
    setView("server");
  };
  const handleKeepOne = () => setGroups((current) => current.map((item) => item.id === group.id ? { ...item, split: undefined } : item));

  /** 견적 나누기(본체가 여러 대): 본체마다 탭을 만들고 요구사항은 모두 복사 */
  const handleQuoteSplit = async () => {
    const parts = group.quote?.split || [];
    if (!parts.length) return;
    const made = parts.map((part, index) => ({
      ...JSON.parse(JSON.stringify(group)) as RequirementGroup,
      id: newGroupId(), name: index === 0 ? group.name : `${group.name} ${index + 1}`,
      quote: { ...part, split: undefined, line_marks: {} }, quote_config: undefined,
    }));
    const madeProfiles = Object.fromEntries(made.map((part) => [part.id, profileFor(part.quote!, undefined)]).filter(([, value]) => value)) as Record<string, ServerProfile>;
    setGroups((current) => current.flatMap((item) => item.id === group.id ? made : [item]));
    setProfiles((current) => { const next = { ...current, ...madeProfiles }; delete next[group.id]; return next; });
    setActiveGroupId(made[0].id);
    await Promise.all(made.map((part) => applyQuote(part.id, part.quote, madeProfiles[part.id] || null)));
  };
  const handleQuoteKeepOne = () => setGroups((current) => current.map((item) => item.id === group.id && item.quote ? { ...item, quote: { ...item.quote, split: undefined } } : item));

  const handleAddServer = (copy: boolean) => {
    const id = newGroupId();
    const used = new Set(groups.map((item) => item.name));
    let index = groups.length + 1;
    while (used.has(`서버 ${index}`)) index++;
    const made: RequirementGroup = copy
      ? { ...JSON.parse(JSON.stringify(group)), id, name: `${group.name} 복사`, split: undefined }
      : emptyGroup(id, `서버 ${index}`);
    const madeProfile = copy && profile ? JSON.parse(JSON.stringify(profile)) as ServerProfile : defaultProfile();
    setGroups((current) => [...current, made]);
    if (madeProfile) setProfiles((current) => ({ ...current, [id]: madeProfile }));
    if (copy && proposalNotes[group.id]) setProposalNotes((current) => ({ ...current, [id]: current[group.id] }));
    setActiveGroupId(id);
    setView("server");
  };
  const handleRename = (id: string, name: string, quantity: number | null) =>
    setGroups((current) => current.map((item) => item.id === id ? { ...item, name, quantity } : item));
  const handleRemoveServer = (id: string) => {
    const target = groups.find((item) => item.id === id);
    if (!target || groups.length < 2) return;
    if (!isBlank(target) && !window.confirm(`'${target.name}' 서버를 삭제할까요? 붙여넣은 내용과 구성이 지워집니다.`)) return;
    const index = groups.findIndex((item) => item.id === id);
    const rest = groups.filter((item) => item.id !== id);
    setGroups(rest);
    setProfiles((current) => { const next = { ...current }; delete next[id]; return next; });
    if (activeGroupId === id) setActiveGroupId(rest[Math.max(0, index - 1)].id);
  };
  const handleMarkLine = (line: number, mark: "skip" | null) =>
    setGroups((current) => current.map((item) => {
      if (item.id !== group.id) return item;
      const marks = { ...(item.line_marks || {}) };
      if (mark) marks[line] = mark; else delete marks[line];
      return { ...item, line_marks: marks };
    }));

  /** 저장 대상: 서버별 붙여넣은 내용·요구사항·구성 전체 (검증 결과·그림은 다시 계산) */
  const snapshot = useMemo(() => JSON.stringify({ workName, groups, profiles, activeGroupId, proposalNotes } satisfies SavedState),
    [workName, groups, profiles, activeGroupId, proposalNotes]);
  const hasWork = groups.some((item) => !isBlank(item)) || groups.length > 1;
  const dirty = hasWork && snapshot !== savedSnapshot;

  const handleSave = async () => {
    setSaveBusy(true);
    setSaveError("");
    try {
      const saved = await saveProject(workName.trim() || `작업 ${stamp()}`, JSON.parse(snapshot));
      setSavedSnapshot(snapshot);
      setSavedAt(saved.saved_at);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaveBusy(false);
    }
  };

  const resetWork = (state: SavedState | null, name: string, at: string) => {
    // 예전 저장본: 견적이 요구사항과 한 칸에 있던 것(proposed)을 견적 칸으로 옮긴다
    const nextGroups = (state?.groups?.length ? state.groups : [emptyGroup(DEFAULT_GROUP_ID, "서버 1")]).map((item) =>
      item.proposed && !item.quote
        ? { ...item, quote: { ...item, requirements: [], split: undefined, quote: undefined }, proposed: undefined, items: undefined, lines: item.doc_role === "quote" ? undefined : item.lines, text: item.doc_role === "quote" ? undefined : item.text }
        : item);
    const nextProfiles = state?.profiles || {};
    nextGroups.forEach((item) => { if (!nextProfiles[item.id]) { const fallback = defaultProfile(); if (fallback) nextProfiles[item.id] = fallback; } });
    const nextActive = nextGroups.some((item) => item.id === state?.activeGroupId) ? state!.activeGroupId : nextGroups[0].id;
    setGroups(nextGroups);
    setProfiles(nextProfiles);
    setActiveGroupId(nextActive);
    setProposalNotes(state?.proposalNotes || {});
    setResults({});
    setRenderedImages({ front: null, rear: null });
    setView("server");
    setWorkName(name);
    setSavedAt(at);
    setPasteError("");
    // 연 직후에는 '저장 안 됨'으로 보이지 않게 같은 형식으로 기억
    setSavedSnapshot(state ? JSON.stringify({ workName: name, groups: nextGroups, profiles: nextProfiles, activeGroupId: nextActive, proposalNotes: state.proposalNotes || {} } satisfies SavedState) : "");
  };
  const handleOpenProject = async (id: string) => {
    setOpenMenu(false);
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 버리고 저장한 작업을 열까요?")) return;
    try {
      const project = await loadProject<SavedState>(id);
      resetWork(project.state, project.name, project.saved_at);
    } catch (reason) {
      setPasteError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const handleNewWork = () => {
    setOpenMenu(false);
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 버리고 새 작업을 시작할까요?")) return;
    resetWork(null, `새 작업 ${stamp()}`, "");
  };
  useEffect(() => {
    if (openMenu) listProjects().then(setSavedProjects).catch(() => setSavedProjects([]));
  }, [openMenu]);
  // 저장하지 않고 창을 닫으려 하면 묻는다
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const handleApplyProposal = async () => {
    setApplyingGroupId(group.id);
    await applyQuote(group.id, group.quote, profile || null);
    setRenderedImages({ front: null, rear: null });
    setApplyingGroupId(null);
  };

  const handleRequirementsChange = (requirements: Requirement[]) => {
    setGroups((current) => current.map((item) => item.id === group.id ? { ...item, requirements } : item));
  };

  const handleServerChange = (id: string) => {
    const nextServer = servers.find((item) => item.id === id);
    if (!nextServer) return;
    const nextProfile: ServerProfile = { serverId: id, config: defaultConfig(nextServer), source: "manual" };
    setProfiles((current) => ({ ...current, [group.id]: nextProfile }));
    // 견적이 있으면 새 모델에 견적을 다시 적용 (견적과 다름 기준도 새 모델 기준으로)
    if (group.quote) void applyQuote(group.id, group.quote, nextProfile);
    setResults((current) => {
      const next = { ...current };
      delete next[group.id];
      return next;
    });
    setImageStatus(null);
    setRenderedImages({ front: null, rear: null });
  };

  const handleConfigChange = (nextConfig: ServerConfig) => {
    setProfiles((current) => {
      const currentProfile = current[group.id];
      return currentProfile ? { ...current, [group.id]: { ...currentProfile, config: nextConfig } } : current;
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
        </div>
        <div className="workline">
          <input className="workname" aria-label="작업 이름" value={workName} onChange={(event) => setWorkName(event.target.value)} title="작업 이름 — 저장할 때 이 이름으로" />
          <span className="muted-on-dark">서버 {groups.length}종 · {groups.reduce((total, item) => total + (item.quantity || 1), 0)}대</span>
          <span className="openwrap">
            <button type="button" className="ghost-on-dark" aria-expanded={openMenu} onClick={() => setOpenMenu(!openMenu)}>열기 ▾</button>
            {openMenu && (
              <span className="openmenu" role="menu">
                <button type="button" role="menuitem" onClick={handleNewWork}><b>＋ 새 작업</b></button>
                {savedProjects.length ? savedProjects.slice(0, 12).map((item) => (
                  <button type="button" role="menuitem" key={item.id} onClick={() => void handleOpenProject(item.id)}>
                    {item.name}<small>서버 {item.servers}종 · {formatSavedAt(item.saved_at)} 저장</small>
                  </button>
                )) : <span className="muted small pad">저장한 작업이 없습니다</span>}
              </span>
            )}
          </span>
        </div>
        <span className="localnote">외부 전송 없음 · 모든 분석은 이 PC에서</span>
        <ServerBar groups={groups} summaries={projectSummaries} activeGroupId={group.id} view={view}
          onSelect={(id) => { setActiveGroupId(id); setView("server"); }} onShowAll={() => setView("all")}
          onAdd={handleAddServer} onRename={handleRename} onRemove={handleRemoveServer} />
      </header>
      {apiReady === false && (
        <div className="stale offline-banner" role="status">
          <span>백엔드 API에 연결되지 않았습니다. 서버 실행 상태를 확인하세요.</span>
          <button className="btn ghost small" onClick={() => { setApiReady(null); setApiRetry((attempt) => attempt + 1); }}>다시 연결</button>
          {loadError && <small role="alert">{loadError}</small>}
        </div>
      )}
      {apiReady === null && <div className="stale" role="status">백엔드 API에 연결하는 중입니다…</div>}
      <div className="layout">
        <main className={view === "server" ? "work" : ""}>
          {view === "server" && <RequirementSection
            key={`req-${group.id}`}
            group={group}
            busy={pasteBusy}
            error={pasteError}
            result={validation}
            onFocus={(request) => setFocus({ ...request, n: Date.now() })}
            onPaste={(text, mode) => void handlePaste(text, mode)}
            onChange={handleRequirementsChange}
            onMarkLine={handleMarkLine}
            onSplit={() => void handleSplit()}
            onKeepOne={handleKeepOne}
          />}
          {view === "server" && <ConfigSection
            key={`cfg-${group.id}`}
            modelLine={<ServerSection
            servers={servers}
            components={components}
            server={server}
            modelSource={profile?.source || "default"}
            modelHint={group.model_hint || null}
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
            diff={diff}
            quotePanel={<QuotePanel
              key={`quote-${group.id}`}
              quote={group.quote}
              busy={quoteBusy}
              error={quoteError}
              servers={servers}
              server={server}
              notes={proposalNotes[group.id]}
              applying={applyingGroupId === group.id}
              diffCount={diff?.count || 0}
              onPaste={(text) => void handleQuotePaste(text)}
              onReapply={() => void handleApplyProposal()}
              onClear={handleClearQuote}
              onSplit={() => void handleQuoteSplit()}
              onKeepOne={handleQuoteKeepOne}
              onMarkLine={handleQuoteMark}
            />}
          />}
          {view === "all" && <ResultSection
            server={server}
            result={validation}
            error={validationError}
            loading={validationBusy}
            projectSummaries={projectSummaries}
            activeGroupId={group.id}
            onSelectGroup={(id) => { setActiveGroupId(id); setView("server"); }}
          />}
          {hasWork && (
            <div className={`savebar ${dirty ? "dirty" : ""}`} role="region" aria-label="저장">
              <span className="savebar-msg">
                {saveError ? <span className="warn">저장 오류: {saveError}</span>
                  : dirty ? <><i className="dot" aria-hidden="true" /> 저장하지 않은 변경이 있습니다</>
                  : <>✓ 저장됨 · {formatSavedAt(savedAt)}</>}
                <span className="muted small"> — {workName}</span>
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
