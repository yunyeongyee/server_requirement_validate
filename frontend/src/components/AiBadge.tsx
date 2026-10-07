import { useEffect, useState } from "react";
import { checkAi, getAiStatus } from "../api";
import type { AiStatus } from "../api";

/** 헤더의 AI 분석 상태. 누르면 설정 요약과 '연결 확인'(키·모델 검사, 토큰 사용 없음). */
export default function AiBadge({ lastMode }: { lastMode?: string | null }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getAiStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status) return null;

  const tone = !status.enabled ? "off" : status.ok === false ? "bad" : "on";
  const label = !status.enabled ? "AI 분석 꺼짐" : `AI 분석 · ${status.model}`;
  return (
    <span className="aibadge">
      <button type="button" className={`ai-chip ai-${tone}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ai-dot" aria-hidden="true" />{label}{lastMode === "ai" ? " · 이 문서에 사용됨" : ""}
      </button>
      {open && (
        <div className="ai-pop" role="dialog" aria-label="AI 분석 설정">
          <dl>
            <div><dt>상태</dt><dd>{status.enabled ? "켜짐" : "꺼짐"}</dd></div>
            <div><dt>API 키</dt><dd>{status.key_set ? status.key_hint : "없음"}</dd></div>
            <div><dt>모델</dt><dd>{status.model}</dd></div>
            <div><dt>사용 범위</dt><dd>{status.mode === "always" ? "요구사항 문서는 항상 AI로 분석" : "애매한 문서만 AI로 분석"}</dd></div>
          </dl>
          {status.message && <p className={status.ok ? "ok-msg" : "warn"}>{status.message}</p>}
          {!status.key_set && <p className="muted small">프로젝트 폴더의 <code>.env.example</code>을 <code>.env</code>로 복사하고 <code>OPENAI_API_KEY=</code> 뒤에 키를 넣은 뒤 다시 실행하세요.</p>}
          <div className="row between">
            <button type="button" className="btn small" disabled={busy || !status.key_set} onClick={async () => {
              setBusy(true);
              try { setStatus(await checkAi()); } finally { setBusy(false); }
            }}>{busy ? "확인 중…" : "연결 확인"}</button>
            <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>닫기</button>
          </div>
        </div>
      )}
    </span>
  );
}
