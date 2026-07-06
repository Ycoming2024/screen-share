@echo off
echo 正在安装依赖...
cd /d "%~dp0"
npm install
echo.
echo 安装完成！正在启动提词器...
npm start
pause
