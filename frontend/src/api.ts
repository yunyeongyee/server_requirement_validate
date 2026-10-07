import type {
  ProposedConfig,
  Component,
  ImageStatus,
  LibraryImage,
  Requirement,
  Server,
  ServerConfig,
  PasteResponse,
  ValidationResult,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (reason) {
    if (reason instanceof TypeError) {
      throw new Error("백엔드 API에 연결할 수 없습니다. 서버 실행 상태와 주소를 확인한 뒤 다시 시도하세요.");
    }
    throw reason;
  }
  if (!response.ok) {
    let message = response.status >= 500
      ? `백엔드 API 서버에서 오류가 발생했습니다 (HTTP ${response.status}). 서버 상태를 확인한 뒤 다시 시도하세요.`
      : response.statusText;
    try {
      const body = (await response.json()) as { detail?: string };
      message = body.detail || message;
    } catch {
      // Keep the HTTP status text when the response is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function sendJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getServers(): Promise<Server[]> {
  return (await request<{ servers: Server[] }>("/api/servers")).servers;
}

export function getComponents(): Promise<Component[]> {
  return request<Component[]>("/api/components");
}


/** 견적·사양 표를 복사해 붙여넣은 글 → 업로드와 같은 형태의 결과 */


export function pasteText(text: string, kind: "requirement" | "quote", ai = false, ruleLines: number[] = []): Promise<PasteResponse> {
  return request("/api/paste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, kind, ai, rule_lines: ruleLines }) });
}

export function validateServer(
  serverId: string,
  config: ServerConfig,
  requirements: Requirement[],
): Promise<ValidationResult> {
  return sendJson("/api/validate", { server_id: serverId, config, requirements });
}

export function getImageStatus(serverId: string, backplane: string): Promise<ImageStatus> {
  return request(`/api/images/${encodeURIComponent(serverId)}?backplane=${encodeURIComponent(backplane)}`);
}

export function renderServer(serverId: string, view: "front" | "rear", config: ServerConfig): Promise<{ url: string | null; missing?: string[] }> {
  return sendJson("/api/render", { server_id: serverId, view, config });
}

export function uploadImageLibrary(files: File[]): Promise<{ job: string }> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  return request("/api/library", { method: "POST", body: form });
}

export function getLibrary(): Promise<LibraryImage[]> {
  return request<{ items: LibraryImage[] }>("/api/library").then((data) => data.items);
}

export function getImageJob(id: string): Promise<{
  state: string;
  stage: string;
  done: number;
  total: number;
  message: string;
  elapsed?: number;
}> {
  return request(`/api/jobs/${encodeURIComponent(id)}`);
}

export function setImageMap(
  serverId: string,
  kind: "front" | "rear" | "component" | "drive" | "psu",
  key: string,
  itemId: string | null,
): Promise<{ ok: boolean }> {
  return sendJson(`/api/images/${encodeURIComponent(serverId)}/map`, { kind, key, item_id: itemId }, "PUT");
}

export function saveHotspots(
  serverId: string,
  hotspots: Record<string, { x: number; y: number; w: number; h: number }>,
): Promise<{ ok: boolean }> {
  return sendJson(`/api/servers/${encodeURIComponent(serverId)}/hotspots`, { hotspots }, "PUT");
}

export function saveBays(
  serverId: string,
  backplaneId: string,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Promise<{ ok: boolean }> {
  return sendJson(`/api/images/${encodeURIComponent(serverId)}/bays/${encodeURIComponent(backplaneId)}`, { rects }, "PUT");
}

export function redetectBays(serverId: string, backplaneId: string): Promise<unknown> {
  return request(`/api/images/${encodeURIComponent(serverId)}/bays/${encodeURIComponent(backplaneId)}/detect`, { method: "POST" });
}

/** 견적서의 제안 구성을 선택한 모델의 서버 구성으로 옮긴다(배치 제안 + 옮기지 못한 항목 안내). */
export function applyProposal(
  serverId: string,
  proposed: ProposedConfig,
  baseConfig: ServerConfig,
  backplaneHint: Record<string, string | number> | null,
): Promise<{ config: ServerConfig; notes: string[] }> {
  return sendJson("/api/proposal/apply", {
    server_id: serverId, proposed, base_config: baseConfig, backplane_hint: backplaneHint,
  });
}





export interface AiStatus {
  enabled: boolean;
  key_set: boolean;
  model: string;
  key_hint: string;
  ok?: boolean;
  message?: string;
}

export function getAiStatus(): Promise<AiStatus> {
  return request("/api/ai/status");
}

export function checkAi(): Promise<AiStatus> {
  return request("/api/ai/check", { method: "POST" });
}
