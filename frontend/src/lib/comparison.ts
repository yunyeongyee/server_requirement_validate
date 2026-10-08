import type { Requirement, ValidationResult } from "../types";

export const requirementLabels: Record<string, string> = {
  rack_type: "Rack", form_factor: "Rack", cpu_cores: "CPU", cpu_core: "CPU", cpu_sockets: "CPU",
  memory_gb: "Memory", disk_size_gb: "Disk", disk_gb: "Disk", raid_level: "RAID",
  nic_speed_gb: "NIC", nic_ports: "NIC Port", fc_speed_gb: "FC HBA", fc_ports: "FC Port",
  raid_controller: "RAID Controller", dual_psu: "Dual PSU", psu_watt: "PSU",
  ocp_required: "OCP", free_pcie: "PCIe", gpu_count: "GPU",
};
const order = ["Rack", "CPU", "Memory", "Disk", "RAID", "NIC", "NIC Port", "FC HBA", "FC Port", "RAID Controller", "Dual PSU", "PSU", "OCP", "PCIe", "GPU"];
export function itemLabel(item: Requirement) { return requirementLabels[item.key] || item.label || item.key; }
export function comparisonRequirements(requirements: Requirement[]) {
  return requirements.filter(item => item.status !== "review" && item.key !== "manual" && !item._new)
    .sort((a, b) => {
      const rank = (item: Requirement) => { const index = order.indexOf(itemLabel(item)); return index < 0 ? order.length : index; };
      return rank(a) - rank(b);
    });
}
export function requirementResult(item: Requirement, result: ValidationResult | null) {
  return result?.requirements.find(row => row.id === item.id);
}
export function requirementCondition(item: Requirement): string {
  if (typeof item.value === "boolean") return item.value ? "필요" : "불필요";
  if (item.value === "" || item.value == null) return item.label;
  const operators: Record<string, string> = { ">=": "이상", "<=": "이하", ">": "초과", "<": "미만", "=": "", "?": "확인 필요" };
  return `${item.value}${item.unit ? ` ${item.unit}` : ""}${operators[item.op] ? ` ${operators[item.op]}` : ""}`;
}
