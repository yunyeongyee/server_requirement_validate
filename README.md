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

## 환경변수 (AI 추출, 선택)
| 변수 | 설명 |
|---|---|
| `SRV_AI_ENABLED` | `1`/`true`이면 활성화 |
| `OPENAI_API_KEY` | API 키 |
| `SRV_AI_MODEL` | 모델명 |
| `SRV_AI_BASE_URL` | 기본 `https://api.openai.com/v1` |

Visio EMF/WMF 변환에는 LibreOffice(`soffice`)가 필요할 수 있다.

## 테스트
```bash
python -m unittest backend.test_ai_extract backend.test_doc_tables
```
참고 견적서 테스트는 `samples/quote_kgict.xlsx`가 있을 때만 실행된다.
