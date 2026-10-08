export function StatusBadge({ status }: { status?: string }) {
  const tone = status === "충족" ? "ok" : status === "미충족" || status === "호환 불가" ? "fail" : status === "확인 필요" ? "review" : "pending";
  return <span className={`comparison-status ${tone}`}>{status || "미검증"}</span>;
}
export function ItemIcon({ label }: { label: string }) {
  const isPower = /PSU/.test(label);
  const isCPU = label === "CPU";
  const isDisk = /Disk|RAID/.test(label);
  return <svg className="item-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {isPower ? <><path d="M12 2v9"/><path d="M7 4a9 9 0 1 0 10 0"/></> : isCPU ? <><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/>{[8,12,16].map(n => <path key={n} d={`M${n} 3v3 M${n} 18v3 M3 ${n}h3 M18 ${n}h3`}/>)}</> : isDisk ? <><rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8 17h.01 M16 17h.01"/></> : <><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h3 M7 14h3 M15 10h2 M15 14h2"/></>}
  </svg>;
}
