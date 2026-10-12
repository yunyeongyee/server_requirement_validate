import type { ServerConfig } from "./types";

/** 견적대로 적용한 구성(base)과 지금 구성(now)의 차이 — 그림에서 직접 바꾼 곳 */
export interface ConfigDiff {
  bays: Set<number>;
  slots: Set<string>;
  psu: boolean;
  spec: boolean;
  count: number;
}

export function configDiff(base: ServerConfig | undefined, now: ServerConfig | null): ConfigDiff | null {
  if (!base || !now || base.backplane !== now.backplane && !Object.keys(base.bays).length && !Object.keys(now.bays).length) return null;
  const bays = new Set<number>();
  new Set([...Object.keys(base.bays), ...Object.keys(now.bays)]).forEach((key) => {
    const a = base.bays[key], b = now.bays[key];
    if (!a !== !b || (a && b && (a.drive !== b.drive || a.role !== b.role))) bays.add(Number(key));
  });
  const slots = new Set<string>();
  new Set([...Object.keys(base.slots), ...Object.keys(now.slots)]).forEach((key) => {
    if ((base.slots[key] || "") !== (now.slots[key] || "")) slots.add(key);
  });
  const psu = base.psu_count !== now.psu_count || base.psu_watt !== now.psu_watt;
  const memory = (cfg: ServerConfig) => cfg.memory.filter((row) => row.qty).map((row) => `${row.size_gb}x${row.qty}`).sort().join(",");
  const spec = base.cpu_model !== now.cpu_model || base.cpu_count !== now.cpu_count || memory(base) !== memory(now);
  return { bays, slots, psu, spec, count: bays.size + slots.size + (psu ? 1 : 0) + (spec ? 1 : 0) };
}
