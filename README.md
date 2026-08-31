# fabric-backend

織物智慧生成系統的後端 API。依 `TTRI-織物智慧生成系統規格書 v1.2 (VJ260601)` 第六章實作。

系統的資料來源是**這裡的資料庫**，不是任何 Excel 或前端靜態檔。
客戶在管理後台（[fabric-admin](../fabric-admin)）建立什麼，前台就有什麼。

## 快速開始

```bash
npm install
npm start          # http://127.0.0.1:3100
```

首次啟動會自動建表並寫入初始資料，終端機會印出管理員帳密：

```
[seed] 已建立管理員帳號：admin / admin1234　← 上線前請務必修改密碼
```

| 指令 | 說明 |
|---|---|
| `npm start` | 啟動伺服器 |
| `npm run dev` | 啟動並監看檔案變更 |
| `npm test` | 端對端測試，86 項，涵蓋八個模組與規格書所有限制條件 |
| `npm run migrate` | 只建表（`--reset` 會先清空資料庫） |
| `npm run seed` | 只寫入初始資料 |
| `npm run reset` | 清空後重建，開發用 |

## 技術選擇

**資料庫走同一份 SQL、兩個 driver。** 開發用 [PGlite](https://pglite.dev)（PostgreSQL 編譯成 WASM，跑在 Node 行程內，免安裝伺服器），正式環境切到 GCP Cloud SQL。兩者都是 PostgreSQL，`schema.sql` 與所有查詢一字不改：

```bash
DB_DRIVER=pglite                                   # 開發，資料落在 .data/pglite
DB_DRIVER=pg  DATABASE_URL=postgres://…            # 正式
```

**檔案儲存同樣抽象化。** `src/storage/` 下有 local 與 gcs 兩個 driver，呼叫端只認得 `put / stream / remove`：

```bash
STORAGE_DRIVER=local  UPLOAD_DIR=uploads           # 開發
STORAGE_DRIVER=gcs    GCS_BUCKET=fabric-assets     # 正式（需 npm i @google-cloud/storage）
```

設定項完整清單見 `.env.example`。

## 架構

```
src/
  server.js          Fastify 進入點、統一錯誤格式
  config.js          環境變數
  db/
    schema.sql       16 張資料表
    index.js         driver 切換（pglite / pg）
    seed.js          初始資料
  lib/
    auth.js          JWT、密碼雜湊、生效期間判定
    scope.js         「適用對象」共用邏輯
    dates.js         日期正規化（時區固定 Asia/Taipei）
    files.js         上傳處理
    validate.js      欄位驗證，錯誤訊息為中文
  storage/           local / gcs driver
  routes/            八個後台模組 + 前台端點
```

### 「適用對象」為什麼是一張共用表

規格書中布樣種類、組織、成分、彈性、組織規格、背景、3D 模型七個模組，
都有同一組欄位（Radio 全域／指定客戶 + Checkbox 客戶清單）與同一條規則
（「當選擇指定客戶時，至少需選擇一項始得儲存」）。

因此不為每個模組各開一張 junction table，而是用 `scope_type` 欄位加上共用的
`scope_customers(entity_type, entity_id, customer_id)`，規則集中在 `lib/scope.js`。
前台的可見性判斷也只有一種寫法：`scope_type = 'global' 或 該客戶在關聯表裡`。

### 權限

規格書第 3 節只有兩種角色，因此不另設角色欄位，直接由帳號的 `customer_id` 判定：

| customer_id | 角色 | 可存取 |
|---|---|---|
| `NULL` | 系統管理者 Admin | `/api/admin/*` 全部 |
| 指向某客戶 | 一般使用者 User | 前台端點，內容依所屬客戶過濾 |

帳號僅於生效期間內可登入，迄日次日起自動失效；清單上的「啟用／停用」即由此推導，
不是另一個可獨立切換的欄位。

## API

後台端點一律需要管理者 token，前台端點登入即可、內容自動依所屬客戶過濾。

```
POST   /api/auth/login              { username, password } → { token, user }
GET    /api/auth/me
```

### 後台 `/api/admin/*`

| 模組 | 端點 |
|---|---|
| 客戶管理 | `GET/POST /customers`、`GET/PUT/DELETE /customers/:id`、`GET /customers/all` |
| 帳號管理 | `GET/POST /accounts`、`GET/PUT/DELETE /accounts/:id` |
| 選項參數 | `/fabric-types`、`/weaves`、`/compositions`、`/elasticities`（各 GET/POST/PUT/DELETE） |
| 布厚布重 | `GET /spec-ranges`、`PUT /spec-ranges/global`、`POST /spec-ranges`、`PUT/DELETE /spec-ranges/:id` |
| 印花管理 | `/pattern-categories`、`/patterns`（上傳為 multipart，可多檔） |
| 組織規格 | `/weave-specs`（multipart：預覽圖 `preview` 單張 + 資料檔 `files` 多檔） |
| 背景管理 | `/backgrounds`（multipart，欄位 `file`） |
| 3D 模型 | `/models-3d`（multipart，欄位 `file`） |

含檔案的請求一律 `multipart/form-data`，陣列型欄位（`customerIds`、`compositions`、
`keepFileIds`）以 JSON 字串夾帶。

### 前台

| 端點 | 內容 |
|---|---|
| `GET /api/options` | 布樣種類、組織（已依布樣種類分組）、成分、彈性、該客戶適用的布厚布重範圍，一次取回 |
| `GET /api/weave-specs` | 組織規格，含預覽圖與 3D 建模檔 |
| `GET /api/patterns` | 一般分類全部 + 該客戶自己的圖庫，附分類清單與圖案實際公分尺寸 |
| `GET /api/backgrounds` | 背景 |
| `GET /api/models-3d` | 3D 模型 |
| `GET /api/files/*` | 檔案讀取。不驗 token（網址帶不可預測的 key），可直接放進 `<img src>` 或 3D loader |

## 與規格書不同之處

| 項目 | 說明 |
|---|---|
| 布厚最大值 | 圖表 21 寫「預設為 34」與同頁畫面圖及第 11 頁的 3.4 mm 不符，判定為筆誤，此處以 **3.4** 為準 |
| 成分「分類」欄 | 圖表 15 的清單有此欄，圖表 16 的欄位表沒有。已實作為選填 |
| 印花的公分尺寸 | 規格書未列。3D 貼圖重複次數 = 模型公分尺寸 ÷ 圖案實際公分尺寸，缺此值大小圖案會貼成同尺寸，因此補為選填欄位 |
| 背景／3D 模型的編輯 | 規格書畫面只有上傳與刪除。調整適用對象不該逼使用者重傳檔案，因此提供只改名稱與適用對象的 `PUT` |

初始資料只建立規格書明文指定為預設值的項目（7 個印花分類、布重布厚全域預設）
與一組管理員帳號。布樣種類、組織、成分、彈性一律由客戶自行在後台建立。

## 部署備註

- TTRI API 的中轉服務尚未實作。該服務需與本後端跑在同一台 GCP 主機上，
  由後端補 token 後轉發，原因見 [fabric-frontend/docs/TTRI-API-回覆與待確認.md](../fabric-frontend/docs/TTRI-API-回覆與待確認.md)
- 上線前務必設定 `JWT_SECRET` 並修改預設管理員密碼
