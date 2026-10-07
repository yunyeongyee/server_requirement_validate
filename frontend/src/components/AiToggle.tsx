import { useState } from "react";
import { checkAi } from "../api";
import type { AiStatus } from "../api";

interface Props {
  status: AiStatus | null;
  on: boolean;
  onChange: (next: boolean) => void;
}

/** 헤더의 'AI 분석' 스위치. 키가 없으면 켤 수 없다. 켜면 붙여넣은 내용(계정·IP 가림)이 OpenAI로 전송된다. */
export default function AiToggle({ status, on, onChange }: Props) {
  const [check, setCheck] = useState("");
  const usable = !!status?.enabled;
  const test = async () => {
    setCheck("확인 중…");
    try {
      const result = await checkAi();
      setCheck(result.message || "");
    } catch (reason) {
      setCheck(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <span className="aitoggle-wrap">
      <label className={`aitoggle ${usable ? "" : "disabled"}`} data-tip={usable ? undefined : "API 키가 없습니다 — .env 의 OPENAI_API_KEY 를 설정하세요"}>
        <input type="checkbox" role="switch" checked={on} disabled={!usable} onChange={(event) => onChange(event.target.checked)} />
        <span className="switch" aria-hidden="true" />
        AI 분석
      </label>
      {usable && <button type="button" className="lnk aitest" title={`모델 ${status?.model} · 클릭하면 연결·크레딧을 확인합니다`} onClick={() => void test()}>연결 확인</button>}
      {check && <span className="aicheck" role="status">{check}</span>}
    </span>
  );
}
