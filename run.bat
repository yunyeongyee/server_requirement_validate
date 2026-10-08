@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 바탕화면 등으로 파일을 복사해 실행한 경우 프로젝트 폴더를 찾아간다
if not exist "requirements.txt" (
  if exist "%USERPROFILE%\server_requirement_validate\requirements.txt" (
    cd /d "%USERPROFILE%\server_requirement_validate"
  ) else (
    echo 프로젝트 폴더를 찾지 못했습니다. run.bat 은 server_requirement_validate 폴더 안에서 실행하세요.
    pause
    exit /b 1
  )
)
echo 프로젝트 폴더: %CD%
title Server Requirement Validator

echo [1/4] 최신 코드 받는 중...
rem 좌표 보정·이미지 선택으로 바뀐 data 파일이 있어도 받도록 --autostash 사용
rem 이전 받기에서 충돌이 남아 있으면 다음 받기가 막히므로 충돌 상태만 푼다 (파일 내용은 앱이 읽을 때 복구)
git reset -q >nul 2>&1
git pull --autostash
if errorlevel 1 (
  echo.
  echo    [주의] 최신 코드를 받지 못했습니다. 예전 코드로 실행됩니다. 위 메시지를 복사해서 보내주세요.
  echo.
)
for /f "delims=" %%c in ('git log -1 --format^="%%h %%s"') do echo    현재 코드: %%c

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo    설정 파일 .env 를 만들었습니다. AI 분석을 쓰려면 .env 를 메모장으로 열어 OPENAI_API_KEY= 뒤에 키를 넣으세요.
)
echo [2/4] 파이썬 패키지 확인 중...
python -m pip install -q -r requirements.txt
if errorlevel 1 goto :fail

echo [3/4] 화면 빌드 중...
pushd frontend
if not exist node_modules call npm install --no-audit --no-fund
call npm install --no-audit --no-fund >nul
call npm run build
if errorlevel 1 (popd & goto :fail)
popd

set PORT=8001
rem 예전에 띄운 서버가 같은 포트를 잡고 있으면 끈다
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo [4/4] 서버 시작: http://localhost:%PORT%
echo    이 창을 닫으면 서버가 꺼집니다.
start "" http://localhost:%PORT%
python -m uvicorn backend.app:app --port %PORT%
pause
exit /b

:fail
echo.
echo 오류가 났습니다. 위 메시지를 복사해서 보내주세요.
pause
