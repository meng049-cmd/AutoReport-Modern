# AutoReport Modern 專案交接

## 專案來源與目的

- Repository：meng049-cmd/AutoReport-Modern，主分支 main。
- 以 meng049-cmd/AutoReport 的 main 程式快照為基礎建立獨立專案。
- 新版已部署至 https://meng049-cmd.github.io/AutoReport-Modern/；GitHub Actions 會從 main 自動建置與發布，採免信箱登入模式。原正式網站不受影響。
- 視覺方向參考 Kiranism shadcn dashboard starter；本專案沿用原生 ES module 架構，保留原本資料處理流程。

## 修改範圍

- web/modern-dashboard.css：新版 dashboard 主題。
- web/index.html：載入新版樣式並更新頁面標題。
- web/build.mjs：將樣式複製到靜態輸出，納入版本雜湊。
- 其餘分析、檔案、Excel 與本機資料模組以原專案為準；除非使用者明確要求，請勿更改統計規則。

## 保留功能

- 工單／料號查找與批次比對、手動補填、PPID 查找。
- 日／週／月良率與不良分析、品質看板、圖表與 Excel 匯出。
- Raw Data、Detail、分析報告與歷史檔案庫。
- 瀏覽器本機資料庫，以及手動匿名雲端備份。

## 建置

npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run build

npm run build 會輸出至 dist/。GitHub Pages 自動部署使用 `bash scripts/build-no-email.sh`。Vercel 設定請看 VERCEL_DEPLOYMENT.md。新版與原站分開部署。

