# server_requirement_validate

고객 요구사항이나 견적 표를 긁어서 붙여넣으면 서버별로 요구사항·구성을 추출하고, 선택한 서버 모델(Dell R760/R660 등)에
대해 요구사항 충족 여부와 슬롯·부품 호환성을 검증하는 웹앱. 전면/후면 이미지 합성도 제공한다.
모든 분석은 이 PC에서 규칙으로 하며 외부로 보내지 않는다.

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

## 작업 저장
작업 화면 맨 아래 "저장하기"를 누르면 서버별 붙여넣은 내용·요구사항·구성이 이 PC의 `data/projects/`에 저장된다 (git에 올라가지 않음). 저장 이름은 헤더의 작업 이름이고, 같은 이름이면 덮어쓴다. 헤더의 "열기 ▾"에서 다시 연다.

## 테스트
```bash
python -m unittest backend.test_paste backend.test_doc_tables backend.test_images
```
참고 견적서 테스트는 `samples/quote_kgict.xlsx`가 있을 때만 실행된다.
