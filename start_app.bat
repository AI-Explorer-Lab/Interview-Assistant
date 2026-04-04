@echo off
cd /d %~dp0
start "" cmd /c "ping 127.0.0.1 -n 3 >nul && start http://127.0.0.1:8765"
python server.py
