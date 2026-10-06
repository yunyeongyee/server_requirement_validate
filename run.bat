@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Server Requirement Validator

echo [1/4] 최신 코드 받는 중...
git pull
if errorlevel 1 echo    (git pull 실패 - 지금 있는 코드로 계속합니다)

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
