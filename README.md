# server_requirement_validate

고객 요구사항 문서/견적서를 업로드하면 서버 구성을 추출하고, 선택한 서버 모델(Dell R760/R660 등)에
대해 요구사항 충족 여부와 슬롯·부품 호환성을 검증하는 웹앱. 전면/후면 이미지 합성도 제공한다.

## 구조
- `backend/` — FastAPI
  - `app.py` API 엔드포인트
  - `extract.py` 문서 본문 추출 + 규칙 기반 요구사항 추출 (PDF/DOCX/XLSX/TXT/CSV/JSON)
  - `doc_tables.py`, `parts.py` 양식 무관 표 해석, 부품코드 해석 (확정 결과는 `data/parts.json`에 누적)
  - `ai_extract.py` (선택) AI 추출
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

## AI 분석 설정 (.env)
프로젝트 폴더의 `.env.example`을 `.env`로 복사하고 값을 채운다 (`run.bat`은 처음 실행할 때 자동으로 복사). `.env`는 git에 올라가지 않는다.

| 변수 | 설명 |
|---|---|
| `OPENAI_API_KEY` | OpenAI API 키. 넣으면 요구사항 문서 AI 분석이 켜진다 |
| `SRV_AI_MODEL` | 모델 (기본 `gpt-5-mini`) |
| `SRV_AI_MODE` | `always`(기본): 요구사항 문서는 항상 AI로 / `auto`: 애매한 문서만 |
| `SRV_AI_ENABLED` | `0`이면 강제로 끔 (비우면 키가 있을 때 켜짐) |
| `SRV_AI_TIMEOUT` | 응답 대기 시간(초, 기본 90) |
| `SRV_AI_BASE_URL` | 기본 `https://api.openai.com/v1` |

견적서·구성도는 표를 규칙으로 읽고, AI에는 보내지 않는다. AI로 보내기 전에 계정·비밀번호·IP는 가린다. 화면 오른쪽 위 "AI 분석" 표시를 누르면 상태 확인과 연결 확인을 할 수 있다.

## 테스트
```bash
python -m unittest backend.test_ai_extract backend.test_doc_tables
```
참고 견적서 테스트는 `samples/quote_kgict.xlsx`가 있을 때만 실행된다.
