@echo off
chcp 65001 > nul
title Shabu & Grill Palace - Buffet Restaurant Demo
echo ====================================================================
echo  🔥 Shabu & Grill Palace - ระบบร้านบุฟเฟต์ & อะลาคาร์ท (Demo)
echo ====================================================================
echo กำลังเริ่มต้นระบบ...

set AGY_NODE="C:\Users\MyPC\AppData\Roaming\Antigravity\bin\agy-node.cmd"

if exist %AGY_NODE% (
    echo กำลังเปิด Server ผ่าน Antigravity Node (พอร์ต 3000)...
    start "" cmd /c "%AGY_NODE% server.js"
    timeout /t 2 > nul
    start http://localhost:3000
    goto end
)

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo กำลังเปิด Server ผ่าน Node.js (พอร์ต 3000)...
    start "" cmd /c "node server.js"
    timeout /t 2 > nul
    start http://localhost:3000
    goto end
)

echo ไม่พบ Node.js ในระบบ กำลังเปิดไฟล์ index.html ใน Browser โดยตรง...
start index.html

:end
echo ====================================================================
echo ระบบพร้อมใช้งานแล้ว! สามารถเปิดดูตัวอย่างบนบราวเซอร์ได้ทันที
echo ====================================================================
