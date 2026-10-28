import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bool = (value, fallback) =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

export const config = {
  port: Number(process.env.PORT ?? 3100),
  host: process.env.HOST ?? '127.0.0.1',

  // 'pglite' — PostgreSQL 編譯成 WASM，免安裝伺服器，開發用。
  // 'pg'     — 連線至真正的 PostgreSQL（正式環境的 Cloud SQL）。
  // 兩者 SQL 方言相同，schema.sql 與所有查詢共用。
  dbDriver: process.env.DB_DRIVER ?? 'pglite',
  dbDataDir: process.env.DB_DATA_DIR ?? resolve(rootDir, '.data/pglite'),
  dbUrl: process.env.DATABASE_URL ?? '',

  // 'local' — 落地至 uploads/；'gcs' — Google Cloud Storage。
  storageDriver: process.env.STORAGE_DRIVER ?? 'local',
  uploadDir: process.env.UPLOAD_DIR ?? resolve(rootDir, 'uploads'),
  gcsBucket: process.env.GCS_BUCKET ?? '',

  // 帳號生效期間的判定基準時區，需與資料庫連線時區一致
  timezone: process.env.TZ_NAME ?? 'Asia/Taipei',

  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174')
    .split(',').map((s) => s.trim()).filter(Boolean),

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
  // 批次匯入的素材壓縮檔另計上限：客戶的資料量大（10/22），一包可能好幾 GB。
  // 匯入時先串流存到 importTmpDir、逐個資料夾讀出處理，記憶體用量與檔案大小無關，
  // 上限 2 GB（10/22）：實測一筆組織約 42 MB，約可放 45～50 筆；再大的話上傳時間過長、
  // 中途失敗要整包重傳，建議客戶分批。磁碟需求約為檔案大小的兩倍（暫存檔 + 解出來的檔案）。
  importMaxBytes: Number(process.env.IMPORT_MAX_BYTES ?? 2 * 1024 * 1024 * 1024),
  importTmpDir: process.env.IMPORT_TMP_DIR ?? resolve(rootDir, 'tmp', 'imports'),
  seedOnBoot: bool(process.env.SEED_ON_BOOT, true),

  // TTRI（紡織所）TandemTex API。token 綁定固定 IP 與單一帳號，且對方僅有 http，
  // 因此所有呼叫都由本服務補上 token 後轉發，token 不得外流至前端。
  ttri: {
    baseUrl: process.env.TTRI_API_BASE_URL ?? '',
    token: process.env.TTRI_API_TOKEN ?? '',
    patternBaseUrl: process.env.TTRI_PATTERN_BASE_URL ?? '',
    // 文件規定：請求間隔建議 1 秒，每分鐘上限 30 次
    minIntervalMs: Number(process.env.TTRI_MIN_INTERVAL_MS ?? 1000),
    rateLimitPerMin: Number(process.env.TTRI_RATE_LIMIT_PER_MIN ?? 30),
  },
};
