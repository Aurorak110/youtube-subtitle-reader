@echo off
cd /d "%~dp0"
echo 正在导出静态网站...
node scripts\export_site.js
echo 正在发布到 Cloudflare Pages...
call npx wrangler pages deploy site --project-name=yt-subtitle-reader --commit-dirty=true
echo.
echo 发布完成!
pause
