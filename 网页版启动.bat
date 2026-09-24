@echo off
chcp 65001 >nul
title 卷帷小说阅读器 · 网页版
cd /d "%~dp0"
echo 正在启动卷帷小说阅读器（网页版）...
echo 关闭本窗口即可退出程序。
echo.

set PY=
where python >nul 2>nul && set PY=python
if "%PY%"=="" ( where py >nul 2>nul && set PY=py )
if "%PY%"=="" (
  echo [错误] 未找到 Python。请先安装 Python，或改用桌面版 卷帷小说阅读器.exe
  pause
  exit /b 1
)

start "" http://127.0.0.1:8123/index.html
%PY% -m http.server 8123 --directory "%~dp0resources\_web"
pause
