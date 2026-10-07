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
}

export interface ExtractionInfo {
  mode: "rules" | "rules_fallback" | "ai";
  effort?: "low" | "medium" | null;
  notice?: string;
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
  library_count: number;
}

export interface UploadResponse {
  filename: string;
  chars: number;
  text: string;
  requirements: Requirement[];
  spec: SpecGroup[];
  groups?: RequirementGroup[];
  extraction?: ExtractionInfo;
  doc_role?: "quote" | "config" | "requirement" | "spec_table";
  common_items?: QuoteItem[];
  inventory?: InventoryRow[];
}

export interface InventoryRow {
  name: string;
  model: string;
  qty: number;
  where: string;
}
