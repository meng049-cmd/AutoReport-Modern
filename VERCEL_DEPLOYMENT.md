# AutoReport Modern 部署至 Vercel

## 部署狀態

此儲存庫是原 AutoReport 的獨立新版。建立儲存庫時尚未建立或發布新版 Vercel 網站；原正式網址仍是 https://auto-report-five.vercel.app/，不代表新版已上線。

## Vercel 設定

1. 在 Vercel 選擇 Add New → Project，匯入 meng049-cmd/AutoReport-Modern。儲存庫維持 Private 時，需讓 Vercel 的 GitHub App 能讀取此儲存庫。
2. 使用以下設定：
   - Framework Preset：Other
   - Root Directory：儲存庫根目錄
   - Install Command：npm ci --include=dev
   - Build Command：bash scripts/build-vercel.sh
   - Output Directory：dist
   - Node.js：24.x
3. 建置腳本會建立 Python 虛擬環境、安裝 requirements.txt，再產生靜態網站。Vercel 建置環境需提供 Python 3 與 venv。
4. 部署完成後，使用 Vercel 指派的正式網址開啟新版；使用自訂網域時，在 Vercel Domains 設定後再更新 Supabase Redirect URLs。

## 雲端同步與登入

部署流程執行 scripts/build-vercel.sh。預設使用免信箱登入模式：分析可在瀏覽器直接使用；只有手動啟用匿名雲端身分並上傳時，資料才會同步。匿名身分無法跨裝置或清除瀏覽器資料後復原。詳細限制請看 CLOUD_SYNC.md。

新版保留原 AutoReport 的 Supabase 公開瀏覽器設定與 app: autoreport，讓原網站與新版可沿用相容的雲端備份。這不是新的 Supabase 隔離專案；若要分開保存，必須另建 Supabase 專案、資料表與 Storage，再更新新版設定。切勿將 service_role、secret key 或資料庫密碼放入前端。

## 上線後確認

- 開啟新版首頁與 release.json，確認頁面版本及來源提交符合部署記錄。
- 在新站以合成資料確認分析與 Excel 下載。新站的瀏覽器 IndexedDB 與原站分開。
- 需要跨裝置備份時，手動啟用匿名雲端身分並上傳；先確認資料內容與備份限制。
- 原站不會因新版部署而更新；兩站的程式碼與部署分開管理。

