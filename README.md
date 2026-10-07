# server_requirement_validate

고객 요구사항이나 견적 표를 긁어서 붙여넣으면 서버별로 요구사항·구성을 추출하고, 선택한 서버 모델(Dell R760/R660 등)에
대해 요구사항 충족 여부와 슬롯·부품 호환성을 검증하는 웹앱. 전면/후면 이미지 합성도 제공한다.
기본은 이 PC에서 규칙으로 분석하고, 오른쪽 위 **AI 분석** 토글을 켜면 AI가 붙여넣은 내용을 정제한다.

## 쓰는 법
1. 서버 탭에 요구사항 문장이나 견적 표(엑셀에서 긁은 것)를 붙여넣고 "분석"
2. 붙여넣은 모든 줄이 ✓ 요구사항/견적 품목 · ⚠ 읽지 못함 · – 검증 대상 아님 중 하나로 표시된다.
   ⚠ 줄은 "항목으로 추가"·"수기 검토로 남기기"·"검증 대상 아님" 중 하나로 직접 정한다 (빠지는 줄이 없게)
3. 서버가 더 필요하면 헤더의 "＋ 서버" (빈 서버 / 지금 서버 복제). 탭을 더블클릭하면 이름·대수 변경
4. 한 번에 여러 서버 내용을 붙여넣으면 "N개 탭으로 나누기"를 제안한다 (자동으로 나누지 않음)

## 구조
- `backend/` — FastAPI
  - `app.py` API 엔드포인트
  - `paste.py` 붙여넣은 글 → 서버 1대 분석 + 줄마다 결과 + 서버 나누기 제안
  - `extract.py` 규칙 기반 요구사항 추출 (CPU 소켓·코어, 메모리, 디스크 개수·용량, RAID, NIC/FC, PSU 등)
  - `doc_tables.py`, `parts.py` 양식 무관 표 해석, 부품코드 해석 (확정 결과는 `data/parts.json`에 누적)
  - `proposal.py` 견적서 제안 구성 → 서버 구성
  - `validate.py` 충족/미충족/호환 불가/확인 필요 판정
  - `images.py`, `visio.py` VSSX/VSDX 이미지 추출, 베이 감지, 전후면 합성
- `frontend/` — React + Vite + TypeScript (빌드 결과는 `static/`으로 출력)
- `data/` — `servers.json`, `components.json`, `image_map.json`
- `static/images/library/` — 이미지 라이브러리 + `manifest.json`

## 실행
Windows: `run.bat` 더블클릭 (최신 코드 받기 → 빌드 → 서버 시작 → 브라우저 열기, 포트 8001)

```bash
./run.sh   # 프론트 빌드 → pip 설치 → http://localhost:8000
```
프론트 개발 서버: `cd frontend && npm run dev` (API는 `SRV_API_TARGET`, 기본 `http://127.0.0.1:8000`로 프록시)

## 저장
서버 이미지 설정(어떤 그림을 쓸지, 베이·슬롯 좌표)만 이 PC에 저장된다. 붙여넣은 요구사항·견적과 구성은 저장하지 않는다.

## AI 분석 (선택)
`.env.example` 을 `.env` 로 복사하고 `OPENAI_API_KEY` 를 넣으면 헤더의 **AI 분석** 토글을 켤 수 있다 (`run.bat` 은 처음 실행할 때 자동으로 복사). 켜면 붙여넣은 내용이 OpenAI로 전송된다 (계정·비밀번호·IP는 가려서).
- 같은 엔진에 `document_type`만 다르다: 왼쪽 칸 = `requirement`(요구사항), 오른쪽 칸 = `quotation`(견적)
- **AI는 의미 이해와 정규화만** 한다 (모델명 ≠ 수량, `2x10Gb` = 2포트×10Gb, 서버 그룹 묶기, 이어진 문장 묶기). **총량 계산·충족 판정·호환성 검증은 Python**이 한다
- AI가 돌려준 숫자는 원문 줄에 실제로 있는지 대조하고, 규칙 파서 결과와 다르면 "AI와 규칙의 해석이 다른 줄"로 표시한다. 기본값은 AI, 줄마다 규칙 값을 고를 수 있다
- 키가 없거나 AI 호출이 실패하면 규칙 결과로 계속하고 이유를 화면에 알린다
- 사내 설치형 모델은 `SRV_AI_BASE_URL` 만 바꾸면 된다 (OpenAI Responses API 호환 필요)

## 보류한 작업 (우선순위 순)
1. **견적 대비 변경 표시**: 그림에서 직접 바꾼 슬롯·디스크·PSU를 견적 원본과 비교해 표시하고 "견적대로 복원".
   계산은 구현됨(`frontend/src/configDiff.ts`), 화면 표시는 `App.tsx`의 `SHOW_QUOTE_DIFF`로 꺼 둠. 용어 확정 필요
2. 결과물 내보내기 (구성도 이미지·비교표)
3. Fujitsu 등 다른 모델·부품 카탈로그 추가

## 테스트
```bash
python -m unittest backend.test_paste backend.test_ai_normalize backend.test_doc_tables backend.test_images
```
참고 견적서 테스트는 `samples/quote_kgict.xlsx`가 있을 때만 실행된다.
