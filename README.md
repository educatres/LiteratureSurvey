# LitFetch — PubMed 批次文獻搜尋與下載

可直接部署到 **GitHub Pages** 的純靜態網頁。無需伺服器、資料庫、OpenAI API Key，也不需要在 GitHub 儲存任何金鑰。

## 功能

- 使用 NCBI PubMed 官方 E-utilities (`ESearch`, `ESummary`, `EFetch`) 搜尋，支援 PubMed Boolean／欄位查詢語法。
- 以出版年份、文獻類型、相關性／日期、PMC Open Access Subset 篩選。
- 每頁 20 篇，支援跨頁挑選，最多一次 100 篇。
- 直接查看摘要、PubMed、PMC 與 DOI 連結。
- 將摘要 TXT、`metadata.csv` 和結果報告打包為 ZIP。
- 僅將 **PMC Open Access Subset** 內、且 Europe PMC 官方全文 API 可取得的全文 XML 打包為 ZIP；無全文的項目會記錄在報告中，不會嘗試規避付費牆。
- 使用者可選填自己的 **NCBI API Key** 與聯絡 Email；不會寫入 localStorage、cookie、網址導覽或程式庫。

> 這不是 AI Skill 的必要使用情境：PubMed 搜尋與匯出可完全透過官方 API 實作。**OpenAI API Key 無法代替 NCBI API Key，也無法解鎖付費論文**。

## GitHub Pages 部署

1. 在 GitHub 建立一個新的**公開** Repository，例如 `litfetch`。
2. 將此資料夾中的全部檔案放到 Repository 的根目錄，包含 `index.html`、`styles.css`、`app.js`、`domain.mjs`、`zip.mjs` 和 `.nojekyll`。
3. 開啟 Repository **Settings → Pages → Build and deployment**。
4. Source 選 **Deploy from a branch**；Branch 選 `main`，Folder 選 `/(root)`，按 **Save**。
5. 等 GitHub Pages 部署完成，網站會出現在 `https://<username>.github.io/<repository>/`。

沒有建置步驟，也不需要 `npm install`；檔案路徑全部相對於網頁根目錄，可在專案型 Pages 網址使用。

## 在電腦上測試

```bash
python3 -m http.server 8080
```

在資料夾根目錄執行，再開啟 `http://localhost:8080/`。請勿直接雙擊 `index.html` 以 `file://` 開啟，因為 JavaScript 模組需要透過 HTTP 載入。

執行無依賴的單元測試：

```bash
npm test
```

## API Key、隱私及使用限制

- **NCBI API Key 是選填**；沒有 Key 的 E-utilities 預設限制約每秒 3 次請求，有 Key 則預設約每秒 10 次。程式採保守的串行節流。
- Key 僅保存在使用者目前頁面的密碼欄位，透過 HTTPS 作為 `api_key` 參數直接送至 `eutils.ncbi.nlm.nih.gov`，不會傳到 LitFetch 開發者的伺服器。使用者需要信任自己打開的網頁程式碼，以及瀏覽器環境；請不要在不可信的頁面輸入 Key。
- `metadata.csv` 使用 UTF-8 BOM 方便 Excel 開啟，並處理可能的 CSV 公式注入。
- 全文 XML 透過 `www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML` 取得。Open Access 不代表完全沒有限制，務必查看論文 XML 中的授權聲明。
- NCBI 提醒：PubMed 摘要的著作權可能屬於作者或出版社；請勿任意再散布。
- NCBI 建議大量自動化請求於美東時間非尖峰時段運行；本工具每次最多 100 篇。
- ZIP 使用未壓縮的 STORE 格式，檔案會比壓縮 ZIP 大；全文總讀取量限制在 120 MiB，避免耗盡瀏覽器記憶體。

## 限制與後續可擴充項目

- **目前批次全文格式為 XML，不是 PDF。** 每篇附有 PMC 原文頁面連結，方便依原網站下載 PDF。若要批次下載 PDF，需逐一核對官方允許的取得管道與授權，並處理各出版社／檔案端點的 CORS、格式和限制。
- 大於 100 篇的任務、長時間佇列、需要登入訂閱的全文，不屬於純 GitHub Pages 版本的範圍。
- 可以新增 RIS／BibTeX 匯出、MeSH 篩選、重複論文偵測、使用者保存查詢清單等功能。

## 官方參考

- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/)
- [NCBI API Key](https://www.ncbi.nlm.nih.gov/books/NBK53593/)
- [NCBI 使用政策](https://www.ncbi.nlm.nih.gov/home/about/policies/)
- [PMC Open Access Subset](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/)
- [Europe PMC REST API](https://dev.europepmc.org/RestfulWebService)

LitFetch 非 NCBI、PubMed、PMC 或 Europe PMC 的官方產品。
