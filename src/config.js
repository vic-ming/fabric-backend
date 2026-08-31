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
  seedOnBoot: bool(process.env.SEED_ON_BOOT, true),
};
