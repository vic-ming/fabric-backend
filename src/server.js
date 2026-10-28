import { createRequire } from 'node:module';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { initDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { initStorage } from './storage/index.js';
import { HttpError } from './lib/errors.js';

import authRoutes from './routes/auth.js';
import customerRoutes from './routes/customers.js';
import accountRoutes from './routes/accounts.js';
import optionRoutes from './routes/options.js';
import specRangeRoutes from './routes/spec-ranges.js';
import patternRoutes from './routes/patterns.js';
import weaveSpecRoutes from './routes/weave-specs.js';
import { backgroundRoutes, model3dRoutes } from './routes/asset-library.js';
import fileRoutes from './routes/files.js';
import importRoutes from './routes/imports.js';
import pantoneRoutes from './routes/pantone.js';
import publicRoutes from './routes/public.js';

// pino-pretty 只是開發時讓 log 好讀，沒裝就退回 JSON log，不讓伺服器起不來。
function prettyTransport() {
  if (!process.stdout.isTTY) return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

export async function buildServer() {
  const app = Fastify({
    logger: { transport: prettyTransport() },
    bodyLimit: config.maxUploadBytes,
    // 所有路由都在 /api 底下。掛在子路徑跑的環境（cPanel 的 Node.js App 掛在
    // /api）有可能把該前綴從 req.url 去掉，這裡補回來，讓同一份程式在本機與
    // 主機上都對得到路由。
    rewriteUrl: (req) => (req.url.startsWith('/api') ? req.url : `/api${req.url}`),
  });

  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 50 },
  });

  // 統一錯誤格式，讓後台介面可以直接把 message 顯示給使用者
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message, details: error.details });
    }
    if (error.validation || error.statusCode === 400) {
      return reply.code(400).send({ error: error.message });
    }
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: `上傳檔案超過大小上限（${Math.round(config.maxUploadBytes / 1024 / 1024)} MB）`,
      });
    }
    request.log.error(error);
    return reply.code(500).send({ error: '伺服器發生錯誤' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `找不到端點 ${request.method} ${request.url}` });
  });

  app.get('/api/health', async () => ({
    ok: true,
    db: config.dbDriver,
    storage: config.storageDriver,
  }));

  await app.register(authRoutes);
  await app.register(fileRoutes);

  // 後台：全部需要管理者權限（各 route 檔內以 requireAdmin hook 把關）
  await app.register(customerRoutes);
  await app.register(accountRoutes);
  await app.register(optionRoutes);
  await app.register(specRangeRoutes);
  await app.register(patternRoutes);
  await app.register(weaveSpecRoutes);
  await app.register(backgroundRoutes);
  await app.register(model3dRoutes);
  await app.register(pantoneRoutes);
  await app.register(importRoutes);

  // 前台：登入即可，內容依所屬客戶過濾
  await app.register(publicRoutes);

  return app;
}

export async function start() {
  await initDb();
  await migrate();
  await initStorage();
  if (config.seedOnBoot) await seed({ log: (msg) => console.log(`[seed] ${msg}`) });

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
