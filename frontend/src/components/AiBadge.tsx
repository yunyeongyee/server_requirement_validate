import { useEffect, useState } from "react";
import { getAiStatus } from "../api";
import type { AiStatus } from "../api";

/** 헤더의 'AI 분석' 토글. 켜면 이후에 올리는 요구사항 문서를 AI로 분석한다 (기본 꺼짐, 브라우저에 기억). */
export default function AiToggle({ on, onChange, usedOnDocument }: { on: boolean; onChange: (next: boolean) => void; usedOnDocument: boolean }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => { getAiStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  const available = !!status?.enabled;
  const tip = !status ? "AI 설정을 불러오는 중"
    : !available ? "API 키가 없어 쓸 수 없습니다 (.env 의 OPENAI_API_KEY)"
      : on ? `켜짐 · ${status.model} — 다음에 올리는 요구사항 문서를 AI로 분석합니다. 견적서·구성도는 보내지 않습니다.`
        : "꺼짐 — 문서를 외부로 보내지 않고 규칙으로만 분석합니다";
  return (
    <label className={`aitoggle ${available ? "" : "disabled"}`} data-tip={tip}>
      <span>AI 분석</span>
      <input type="checkbox" role="switch" checked={available && on} disabled={!available} onChange={(event) => onChange(event.target.checked)} aria-label="AI 분석 사용" />
      <span className="switch" aria-hidden="true" />
      {usedOnDocument && <small>이 문서에 사용됨</small>}
    </label>
  );
}
