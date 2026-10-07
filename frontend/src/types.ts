export interface Requirement {
  id: string;
  key: string;
  label: string;
  op: string;
  value: string | number | boolean | null;
  unit?: string;
  source: string;
  sources?: string[];
  status: string;
  note?: string;
  confidence?: number;
  _new?: boolean;
  /** 근거가 된 붙여넣은 줄 번호 (대표 줄 / 함께 읽은 줄들) */
  line?: number;
  lines?: number[];
  /** 'NIC 4포트'가 몇 GbE 이상 포트인지 (속도별 포트 요구) */
  at_speed?: number;
  /** 사용자가 직접 고치거나 추가한 항목 — 다시 분석해도 남긴다 */
  _user?: boolean;
}

/** 붙여넣은 한 줄을 무엇으로 읽었는지 */
export interface PasteLine {
  n: number;
  text: string;
  /** req 요구사항 / part 견적 품목 / skip 검증 대상 아님 / head 제목 / warn 읽지 못함 */
  status: "req" | "part" | "skip" | "head" | "warn";
  label?: string;
  hint?: string;
}

export interface SpecItem {
  label?: string;
  value: string;
  source: string;
  kind?: "configuration" | "quote" | "common_option";
  confidence?: number;
}

export interface SpecGroup {
  category: string;
  items: SpecItem[];
}

export interface QuoteItem {
  code: string;
  desc: string;
  qty: number | null;
  category: string;
  category_ko: string;
  attrs: Record<string, string | number>;
  confidence: number;
  how?: string;
  where: string;
}

export interface ProposedConfig {
  cpu: { model: string | null; count: number; cores?: number | null };
  memory: { total_gb: number; dimms: Array<{ size_gb: number; qty: number }> };
  drives: Array<{ desc: string; qty: number; size_gb?: number; iface?: string; ff?: string; media?: string }>;
  raid: string[];
  nic: Array<{ desc: string; qty: number; speed_gb?: number; ports?: number; height?: string }>;
  ocp: Array<{ desc: string; qty: number; speed_gb?: number; ports?: number }>;
  fc: Array<{ desc: string; qty: number; speed_gb?: number; ports?: number; height?: string }>;
  gpu: Array<{ desc: string; qty: number }>;
  riser: Array<{ desc: string; qty: number }>;
  psu: { watt: number | null; count: number };
}

export interface RequirementGroup {
  id: string;
  name: string;
  quantity?: number | null;
  requirements: Requirement[];
  spec: SpecGroup[];
  /** quote: 견적서(제안 구성) / requirement: 요구사항 문서 */
  doc_role?: "quote" | "config" | "requirement" | "spec_table";
  evidence?: string[];
  confidence?: number;
  notes?: string[];
  name_how?: string;
  model_hint?: string | null;
  base_desc?: string | null;
  suggested_server?: string | null;
  /** 납품·장비 목록에서 연결한 항목 이름 */
  inventory_link?: string | null;
  items?: QuoteItem[];
  proposed?: ProposedConfig;
  /** 이 서버에 붙여넣은 원문과 줄마다 결과 */
  text?: string;
  lines?: PasteLine[];
  /** 사용자가 '검증 대상 아님'으로 정한 줄 */
  line_marks?: Record<number, "skip">;
  /** 붙여넣은 내용에 서버가 여럿 보일 때 나누기 제안 */
  split?: RequirementGroup[];
  common_lines?: number;
  /** 오른쪽 칸에 붙여넣은 견적 (요구사항과 따로) */
  quote?: RequirementGroup;
  /** 이 붙여넣기를 AI로 정제했는지, 규칙과 다른 줄 */
  ai?: AiInfo;
  /** 견적대로 적용했을 때의 구성 — 그림에서 직접 바꾼 곳을 '견적 대비 변경'으로 표시하는 기준 */
  quote_config?: ServerConfig;
}

/** AI 해석과 규칙 파서 해석이 다른 줄 (기본값은 AI, 줄마다 규칙 값을 고를 수 있다) */
export interface AiConflict {
  line: number;
  text: string;
  kind: "diff" | "unverified";
  ai: string;
  rule: string | null;
  unverified: string[];
  can_use_rule: boolean;
  using: "ai" | "rule";
}

export interface AiInfo {
  used: boolean;
  model?: string;
  notice: string | null;
  conflicts: AiConflict[];
  rule_lines: number[];
}

export interface PasteResponse {
  ai?: AiInfo;
  server: RequirementGroup;
  error?: string;
  split: RequirementGroup[];
  common_lines: number;
  inventory?: InventoryRow[];
}


export interface ProjectSummary {
  id: string;
  name: string;
  model: string;
  matched: number;
  failed: number;
  review: number;
  verdict: string;
}

export interface Backplane {
  id: string;
  name: string;
  bays: number;
  ff: string;
}

export interface Slot {
  id: string;
  label: string;
  type: string;
  gen: number;
  lanes: number;
  height: string;
  double_width_ok: boolean;
  cpu: number;
  riser: string | null;
  hotspot?: { x: number; y: number; w: number; h: number };
}

export interface DriveOption {
  id: string;
  name: string;
  ff: string;
  iface: string;
}

export interface Server {
  id: string;
  vendor: string;
  family: string;
  model: string;
  form_factor: string;
  cpu_sockets: number;
  cpu_options: string[];
  memory: {
    dimm_slots: number;
    max_gb: number;
    dimm_sizes_gb: number[];
  };
  pcie_gen: string;
  ocp: { supported: boolean; version: string; lanes: number };
  psu_options: number[];
  psu_bays: number;
  gpu: { supported: boolean; max_double_width: number; max_single_width: number };
  risers: Array<{ id: string; name: string; default?: boolean }>;
  backplanes: Backplane[];
  slots: Slot[];
  drive_options: DriveOption[];
  /** 후면 PSU 베이 위치 (PSU1부터 순서대로 채움) */
  /** 후면 그림에서 이 모델로는 쓸 수 없는 영역 (검정 박스로 가림) */
  rear_blocked?: Array<{ x: number; y: number; w: number; h: number; reason: string }>;
  psu_slots?: Array<{ id: string; label: string; hotspot?: { x: number; y: number; w: number; h: number } }>;
}

export interface ServerConfig {
  cpu_model: string;
  cpu_count: number;
  memory: Array<{ size_gb: number; qty: number }>;
  backplane: string;
  bays: Record<string, { drive: string; role: "boot" | "data" }>;
  raid: { boot: string; data: string };
  boss: boolean;
  psu_watt: number;
  psu_count: number;
  risers: string[];
  slots: Record<string, string>;
}

export interface Component {
  id: string;
  name: string;
  category: string;
  form: string;
  lanes: number;
  height: string;
  double_width: boolean;
  short: string;
}

export interface ValidationIssue {
  status: string;
  msg: string;
}

export interface ValidationResult {
  general: ValidationIssue[];
  summary: { power_est_w: number; memory_gb: number; free_pcie: number };
  slots: Array<{
    slot: string;
    label: string;
    component: string | null;
    component_id?: string;
    status: string | null;
    issues: ValidationIssue[];
    usable: boolean;
  }>;
  bays: Array<{
    bay: number;
    drive: string;
    role: string;
    status: string;
    issues: ValidationIssue[];
  }>;
  requirements: Array<{
    id: string;
    requirement: string;
    actual: string;
    status: string;
    note: string;
  }>;
}

export interface ImageRef {
  id: string;
  name: string;
  url: string;
}

export interface LibraryImage {
  id: string;
  name: string;
  category: string;
  source: string;
  file: string;
}

export interface ImageStatus {
  front: { item: ImageRef | null; auto: boolean; stencil?: string };
  rear: { item: ImageRef | null; auto: boolean; stencil?: string };
  bays: { rects: Array<{ x: number; y: number; w: number; h: number }>; candidates?: Array<{ x: number; y: number; w: number; h: number }> };
  components: Record<string, { item: ImageRef | null; auto: boolean }>;
  drives: Record<string, { item: ImageRef | null; auto: boolean }>;
  /** 용량(W)별 PSU 이미지. exact=false 면 다른 용량 이미지로 대체 중 */
  psus?: Record<string, { item: ImageRef | null; auto: boolean; exact: boolean }>;
  library_count: number;
}


export interface InventoryRow {
  name: string;
  model: string;
  qty: number;
  where: string;
}
