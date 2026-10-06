#!/usr/bin/env bash
cd "$(dirname "$0")"
cd frontend
npm ci
npm run build
cd ..
pip install -r requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
