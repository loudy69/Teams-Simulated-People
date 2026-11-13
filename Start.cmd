@echo off
cd /d "%~dp0"
if not exist node_modules call "%~dp0Install.cmd"
start "" http://localhost:3000
node server.js
pause
