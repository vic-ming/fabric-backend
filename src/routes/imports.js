// 批次匯入。依「批次匯入規格」實作四張表，另加 10/22 客戶要求的印花：
//   Pantone / 成分 / 組織代碼 / 組織 / 印花
//
// 共用規則見 lib/batch-import.js 的檔頭說明。
// 每支端點都以 multipart 收一個 .xlsx（組織、印花另加一個素材 .zip），
// 回傳成功筆數、被略過的編號、以及失敗的列號與原因。
//
// 素材包可能好幾 GB（客戶的資料量大，10/22）：不讀進記憶體，而是串流存成暫存檔，
// 只讀 zip 的目錄，處理到哪一筆才從磁碟讀出那一筆的檔案。請求結束一律刪掉暫存檔。

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { many, one, tx } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import {
  GLOBAL_COMPANY, assertColumns, createScopeResolver, rgbToHex, runImport, toInt, toNumber, toText,
} from '../lib/batch-import.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { ENTITY, assertScopedCodeUnique, writeScope } from '../lib/scope.js';
import { parseU3m } from '../lib/u3m.js';
import { readSheet } from '../lib/xlsx.js';
import { openZipFile } from '../lib/zip.js';
import { buildStorageKey, storage } from '../storage/index.js';

const tooLarge = () => new HttpError(
  413, `素材壓縮檔超過匯入上限（${(config.importMaxBytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB）`,
);

/**
 * 收下 multipart 裡的檔案，依欄位名分類。
 *   Excel（file）很小，直接讀進記憶體 → { filename, buffer }
 *   素材包（assets）串流寫進暫存目錄 → { filename, path }
 * 回傳的 cleanup 必須在 finally 呼叫，刪掉暫存檔。
 */
async function receiveImport(request) {
  if (!request.isMultipart()) throw badRequest('請以 multipart/form-data 上傳');
  await mkdir(config.importTmpDir, { recursive: true });
  const dir = await mkdtemp(join(config.importTmpDir, 'import-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  const files = {};
  try {
    for await (const part of request.parts({ limits: { fileSize: config.importMaxBytes } })) {
      if (part.type !== 'file') continue;
      if (part.fieldname === 'assets') {
        const path = join(dir, 'assets.zip');
        await pipeline(part.file, createWriteStream(path));
        if (part.file.truncated) throw tooLarge();
        files.assets = { filename: part.filename, path };
      } else {
        files[part.fieldname] = { filename: part.filename, buffer: await part.toBuffer() };
      }
    }
  } catch (error) {
    await cleanup();
    throw error.code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : error;
  }
  return { files, cleanup };
}

/** 收檔 → 執行 → 不論成敗都清掉暫存檔。 */
async function withImport(request, handler) {
  const { files, cleanup } = await receiveImport(request);
  try {
    return await handler(files);
  } finally {
    await cleanup();
  }
}

/** 開啟素材壓縮檔；zip 結構有問題時回 400 而不是 500。用完要 close。 */
async function openAssets(file, label) {
  if (!file) throw badRequest(`請一併選擇${label}（.zip）`);
  if (!/\.zip$/i.test(file.filename ?? '')) throw badRequest(`${label}只接受 .zip 格式（收到 ${file.filename}）`);
  try {
    return await openZipFile(file.path);
  } catch (error) {
    throw badRequest(`${label}無法讀取：${error.message}`);
  }
}

function readXlsx(file, label) {
  if (!file) throw badRequest(`請選擇${label}的 Excel 檔`);
  if (!/\.xlsx$/i.test(file.filename ?? '')) {
    throw badRequest(`${label}只接受 .xlsx 格式（收到 ${file.filename}）`);
  }
  try {
    return readSheet(file.buffer);
  } catch (error) {
    throw badRequest(`${label} Excel 檔無法讀取：${error.message}`);
  }
}

/**
 * 編號已存在就跳過不覆蓋。沿用 assertScopedCodeUnique 的「同公司不可重複」規則：
 * 它撞號時丟 409，這裡接住並轉成「略過」。
 */
async function existsInScope({ table, entityType, code, scope, sameAs }) {
  try {
    await assertScopedCodeUnique({ table, entityType, code, scope, sameAs });
    return false;
  } catch (error) {
    if (error.statusCode === 409) return true;
    throw error;
  }
}

export default async function importRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  // ------------------------------------------------------------ Pantone

  app.post('/api/admin/imports/pantone', async (request) => withImport(request, async (files) => {
    const { headers, rows } = readXlsx(files.file, 'Pantone');
    assertColumns(headers, ['PANTONE_NO', 'TYPE', 'R', 'G', 'B', '公司名稱'], 'Pantone');
    const resolveScope = await createScopeResolver();

    // 不同系列（TYPE）會有相同色號，「系列＋色號」相同才算重複（10/22 客戶確認）
    const seriesKey = (row) => `${String(row.TYPE ?? '').trim()}|${String(row.PANTONE_NO ?? '').trim()}`;

    return runImport(rows, (row) => row.PANTONE_NO, async (row) => {
      const code = toText(row.PANTONE_NO, '色號', 50);
      const colorType = toText(row.TYPE, 'TYPE', 20, { required: false });
      const scope = resolveScope(row.公司名稱);
      if (await existsInScope({
        table: 'pantone_colors', entityType: ENTITY.pantone, code, scope, sameAs: { color_type: colorType },
      })) {
        return 'skipped';
      }

      const r = toInt(row.R, 'R', { min: 0, max: 255 });
      const g = toInt(row.G, 'G', { min: 0, max: 255 });
      const b = toInt(row.B, 'B', { min: 0, max: 255 });
      const optional = (key) => toNumber(row[key], key, { required: false }) ?? 0;

      await tx(async (dbx) => {
        const created = await dbx.query(
          `insert into pantone_colors
             (code, name, color_type, r, g, b, c, m, y, k, lab_l, lab_a, lab_b, hex, scope_type, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   coalesce((select max(sort_order) from pantone_colors), 0) + 1)
           returning id`,
          // 名稱欄為 10/22 新增，可留白；舊格式沒有這欄也照常匯入
          [code, toText(row.名稱, '名稱', 100, { required: false }), colorType, r, g, b,
           optional('C'), optional('M'), optional('Y'), optional('K'),
           optional('Lab_L'), optional('Lab_a'), optional('Lab_b'),
           rgbToHex(r, g, b), scope.scopeType],
        ).then((res) => res.rows[0]);
        await writeScope(dbx, ENTITY.pantone, created.id, scope);
      });
      return 'imported';
    }, { keyOf: seriesKey, skipReason: '同系列的色號已存在，未覆蓋' });
  }));

  // ------------------------------------------------------------ 成分

  app.post('/api/admin/imports/compositions', async (request) => withImport(request, async (files) => {
    const { headers, rows } = readXlsx(files.file, '成分');
    assertColumns(headers, ['編號', '名稱', '中文名稱', '公司名稱'], '成分');
    const resolveScope = await createScopeResolver();

    return runImport(rows, (row) => row.編號, async (row) => {
      const code = toText(row.編號, '編號', 50);
      const scope = resolveScope(row.公司名稱);
      // 成分編號是全域唯一（規格書 6-(3)），不走同公司那套
      if (await one('select id from compositions where code = $1', [code])) return 'skipped';

      await tx(async (dbx) => {
        const created = await dbx.query(
          `insert into compositions (code, name_en, name_zh, scope_type,
                                     sort_order)
           values ($1, $2, $3, $4, coalesce((select max(sort_order) from compositions), 0) + 1)
           returning id`,
          [code, toText(row.名稱, '名稱', 50), toText(row.中文名稱, '中文名稱', 50), scope.scopeType],
        ).then((res) => res.rows[0]);
        await writeScope(dbx, ENTITY.composition, created.id, scope);
      });
      return 'imported';
    });
  }));

  // ------------------------------------------------------------ 組織代碼

  app.post('/api/admin/imports/weaves', async (request) => withImport(request, async (files) => {
    const { headers, rows } = readXlsx(files.file, '組織代碼');
    assertColumns(headers, ['組織代碼', '英文名稱', '中文名稱', '公司名稱'], '組織代碼');
    const resolveScope = await createScopeResolver();

    // 組織必須掛在某個布樣種類底下，匯入檔沒有這欄。
    // 以組織代碼的前兩碼（CWD→CW、WOT→WO）對不上任何布樣種類時直接報錯，
    // 請客戶先在選項參數管理建好布樣種類。
    const fabricTypes = await many('select id, code from fabric_types');

    return runImport(rows, (row) => row.組織代碼, async (row) => {
      const code = toText(row.組織代碼, '組織代碼', 50);
      const scope = resolveScope(row.公司名稱);
      if (await existsInScope({ table: 'weaves', entityType: ENTITY.weave, code, scope })) {
        return 'skipped';
      }

      const prefix = code.slice(0, 2).toUpperCase();
      const fabricType = fabricTypes.find((t) => t.code.toUpperCase() === prefix);
      if (!fabricType) {
        throw badRequest(`找不到編號為 ${prefix} 的布樣種類，請先於選項參數管理建立`);
      }

      await tx(async (dbx) => {
        const created = await dbx.query(
          `insert into weaves (code, name, name_en, fabric_type_id, scope_type, sort_order)
           values ($1, $2, $3, $4, $5, coalesce((select max(sort_order) from weaves), 0) + 1)
           returning id`,
          [code, toText(row.中文名稱, '中文名稱', 50), toText(row.英文名稱, '英文名稱', 100, { required: false }),
           fabricType.id, scope.scopeType],
        ).then((res) => res.rows[0]);
        await writeScope(dbx, ENTITY.weave, created.id, scope);
      });
      return 'imported';
    });
  }));

  // ------------------------------------------------------------ 組織（組織規格）

  app.post('/api/admin/imports/weave-specs', async (request) => withImport(request, async (files) => {
    const { headers, rows } = readXlsx(files.file, '組織');
    assertColumns(headers,
      ['編號', '組織代碼', '布重', '布厚', '成分', '組織資料', '公司名稱'], '組織');
    const zip = await openAssets(files.assets, '素材壓縮檔');
    try {
      return await importWeaveSpecs(rows, zip);
    } finally {
      await zip.close();
    }
  }));

  async function importWeaveSpecs(rows, zip) {
    const batch = indexBatchZip(zip.entries);

    const resolveScope = await createScopeResolver();
    const weaves = await many('select id, code, fabric_type_id from weaves');
    const weaveByCode = new Map(weaves.map((w) => [w.code.toUpperCase(), w]));
    const comps = await many('select id, code, name_en from compositions');
    const compositionLookup = {
      byCode: new Map(comps.map((c) => [c.code.toUpperCase(), c.id])),
      // 只用來在客戶誤填名稱時，提示該改填哪個編號
      byName: new Map(comps.map((c) => [String(c.name_en ?? '').trim().toLowerCase(), c.code])),
    };

    return runImport(rows, (row) => row.編號, async (row) => {
      const code = toText(row.編號, '編號', 50);
      const scope = resolveScope(row.公司名稱);
      if (await existsInScope({ table: 'weave_specs', entityType: ENTITY.weaveSpec, code, scope })) {
        return 'skipped';
      }

      const weaveCode = toText(row.組織代碼, '組織代碼', 50);
      const weave = weaveByCode.get(weaveCode.toUpperCase());
      if (!weave) throw badRequest(`組織代碼「${weaveCode}」在系統中不存在，請先匯入組織代碼`);

      // 布重／布厚匯入時不限範圍：各廠商布料差異大，TTRI 10/20 確認不檢查。
      // 後台「布厚布重範圍設定」只用於前台搜尋，與匯入無關。
      // 這裡只擋資料庫欄位本身的上下限（numeric(6,2)），避免撞到 check constraint 時回出看不懂的錯誤。
      const weight = toNumber(row.布重, '布重', { min: 0, max: 999.99 });
      const thickness = toNumber(row.布厚, '布厚', { min: 0, max: 999.99 });
      const warp = toInt(row.經密, '經密', { required: false }) ?? 0;
      const weft = toInt(row.緯密, '緯密', { required: false }) ?? 0;
      const finishing = toText(row.後整理, '後整理', 100, { required: false }) ?? '無';
      const compositions = parseCompositionText(row.成分, compositionLookup);

      const assetKey = toText(row.組織資料, '組織資料', 100);
      const folderEntries = batch.byFolder.get(assetKey);
      if (!folderEntries || folderEntries.size === 0) {
        throw badRequest(`壓縮檔裡找不到「${assetKey}」資料夾`);
      }
      const thumbnailEntry = batch.thumbnails.get(assetKey);
      if (!thumbnailEntry) throw badRequest(`壓縮檔裡找不到 ${assetKey}_Thumbnail.jpg`);

      // 只讀出這一筆的檔案，記憶體用量以「一筆布樣」為上限，與整包大小無關
      const folderFiles = [];
      for (const [filename, entry] of folderEntries) folderFiles.push([filename, await zip.read(entry)]);
      const thumbnail = await zip.read(thumbnailEntry);
      // 尺寸一律取自 .u3m，Excel 的尺寸X／尺寸Y 即使有填也忽略；讀不到就列為失敗（10/22 客戶確認）
      const { widthCm, heightCm } = sizeFromU3m(assetKey, folderFiles);

      await tx(async (dbx) => {
        const previewId = await storeFromZip(
          dbx, `${assetKey}_Thumbnail.jpg`, thumbnail, 'weave-specs/preview',
        );
        const created = await dbx.query(
          `insert into weave_specs
             (code, fabric_type_id, weave_id, weight, thickness, warp_density, weft_density,
              finishing, design_width_cm, design_height_cm, preview_file_id, scope_type)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [code, weave.fabric_type_id, weave.id, weight, thickness, warp, weft,
           finishing, widthCm, heightCm, previewId, scope.scopeType],
        ).then((res) => res.rows[0]);

        for (const [compositionId, percent] of compositions.map((c) => [c.compositionId, c.percent])) {
          await dbx.query(
            'insert into weave_spec_compositions (weave_spec_id, composition_id, percent) values ($1,$2,$3)',
            [created.id, compositionId, percent],
          );
        }

        let order = 0;
        for (const [filename, content] of folderFiles) {
          const fileId = await storeFromZip(dbx, filename, content, 'weave-specs/data');
          await dbx.query(
            'insert into weave_spec_files (weave_spec_id, file_id, sort_order) values ($1,$2,$3)',
            [created.id, fileId, order],
          );
          order += 1;
        }

        await writeScope(dbx, ENTITY.weaveSpec, created.id, scope);
      });
      return 'imported';
    });
  }

  // ------------------------------------------------------------ 印花

  // 10/22 客戶確認的規則：
  //   ・公司名稱留白或填 TTRI → 一般分類，歸在「分類」欄指定的分類下；分類不存在就自動建立
  //   ・公司名稱填客戶 → 該客戶的圖庫，「分類」欄不使用
  //   ・尺寸以 Excel 填寫的為準，與圖檔比例不符也不擋
  //   ・圖檔打包成 .zip，以「檔案名稱」對應（不分大小寫、不看資料夾層級）
  // 印花沒有編號，所以以「同名稱、同檔名、同歸屬」視為已存在而略過，避免同一份檔案匯兩次變兩份。
  app.post('/api/admin/imports/patterns', async (request) => withImport(request, async (files) => {
    const { headers, rows } = readXlsx(files.file, '印花');
    assertColumns(headers, ['檔案名稱', '印花名稱', '分類', '尺寸寬', '尺寸高'], '印花');
    const zip = await openAssets(files.assets, '圖檔壓縮檔');
    try {
      return await importPatterns(rows, zip);
    } finally {
      await zip.close();
    }
  }));

  async function importPatterns(rows, zip) {
    const images = indexImageZip(zip.entries);

    const customers = await many('select id, name from customers');
    const customerByName = new Map(customers.map((c) => [c.name.trim(), c.id]));
    const categories = await many('select id, name from pattern_categories');
    const categoryByName = new Map(categories.map((c) => [c.name.trim(), c.id]));

    async function ensureCategory(name) {
      if (categoryByName.has(name)) return categoryByName.get(name);
      const row = await one(
        `insert into pattern_categories (name, sort_order)
         values ($1, coalesce((select max(sort_order) from pattern_categories), 0) + 1)
         on conflict (name) do update set name = excluded.name
         returning id`,
        [name],
      );
      categoryByName.set(name, row.id);
      return row.id;
    }

    return runImport(rows, (row) => row.檔案名稱, async (row) => {
      const filename = toText(row.檔案名稱, '檔案名稱', 255);
      const imageEntry = images.get(filename.toLowerCase());
      if (!imageEntry) throw badRequest(`壓縮檔裡找不到圖檔「${filename}」`);
      const mime = imageMime(filename);
      if (!mime) throw badRequest(`「${filename}」不是支援的圖片格式（JPG、PNG、GIF、WEBP）`);

      const name = toText(row.印花名稱, '印花名稱', 255, { required: false }) ?? filename;
      const width = toNumber(row.尺寸寬, '尺寸寬', { required: false, min: 0.001, max: 99999 });
      const height = toNumber(row.尺寸高, '尺寸高', { required: false, min: 0.001, max: 99999 });

      const company = String(row.公司名稱 ?? '').trim();
      let kind = 'general';
      let customerId = null;
      let categoryName = null;
      if (company && company.toUpperCase() !== GLOBAL_COMPANY) {
        kind = 'customer';
        customerId = customerByName.get(company);
        if (!customerId) throw badRequest(`公司名稱「${company}」在系統中不存在，請先於客戶管理建立`);
      } else {
        categoryName = toText(row.分類, '分類', 50);
      }

      const exists = await one(
        `select p.id from patterns p join files f on f.id = p.file_id
          where p.name = $1 and lower(f.original_name) = lower($2) and p.kind = $3
            and (case when $3 = 'general'
                      then p.category_id = (select id from pattern_categories where name = $4)
                      else p.customer_id = $5 end)
          limit 1`,
        [name, filename, kind, categoryName, customerId],
      );
      if (exists) return 'skipped';

      const categoryId = kind === 'general' ? await ensureCategory(categoryName) : null;
      const image = await zip.read(imageEntry);
      await tx(async (dbx) => {
        const fileId = await storeFromZip(dbx, filename, image, 'patterns');
        await dbx.query(
          `insert into patterns (kind, category_id, customer_id, name, file_id,
                                 physical_width_cm, physical_height_cm)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [kind, categoryId, customerId, name, fileId, width, height],
        );
      });
      return 'imported';
    }, { skipReason: '相同名稱、檔名與分類的印花已存在，未重複匯入' });
  }
}

// ------------------------------------------------------------ 印花

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const imageMime = (filename) => IMAGE_TYPES[String(filename).split('.').pop().toLowerCase()] ?? null;

/** 印花圖檔壓縮包：檔名（小寫）→ zip 項目。資料夾層級不影響對應。 */
function indexImageZip(entries) {
  const images = new Map();
  for (const entry of entries) {
    const filename = entry.name.split('/').filter(Boolean).at(-1);
    if (!filename || isJunk(filename) || filename.startsWith('._') || entry.name.startsWith('__MACOSX/')) continue;
    images.set(filename.toLowerCase(), entry);
  }
  return images;
}

// ------------------------------------------------------------ 組織（組織規格）

/**
 * 從組織資料夾裡的 .u3m 讀出實際尺寸（公分）。沒有 .u3m 或讀不到尺寸都視為失敗。
 * @param folderFiles [檔名, 內容][]
 */
function sizeFromU3m(assetKey, folderFiles) {
  const entry = folderFiles.find(([filename]) => /\.u3m$/i.test(filename));
  if (!entry) throw badRequest(`「${assetKey}」資料夾裡沒有 .u3m 檔，無法取得尺寸`);
  const parsed = parseU3m(entry[1]);
  if (!parsed) throw badRequest(`${entry[0]} 不是有效的 .u3m（內容無法解析）`);
  if (!parsed.designWidthCm || !parsed.designHeightCm) {
    throw badRequest(`${entry[0]} 裡讀不到尺寸（basecolor 貼圖未記錄 width／height）`);
  }
  return { widthCm: parsed.designWidthCm, heightCm: parsed.designHeightCm };
}

// Windows 會在資料夾裡塞這些檔，匯入時一律忽略
const JUNK = new Set(['desktop.ini', 'icon.ico', 'thumbs.db', '.ds_store']);
const isJunk = (name) => JUNK.has(name.toLowerCase());

/**
 * zip 內的路徑可能多包一層最外層資料夾，統一用「檔名」與「上層資料夾」判斷歸屬。
 * 只建索引（zip 項目），不讀內容。
 */
function indexBatchZip(entries) {
  const byFolder = new Map();   // 組織資料資料夾名稱 → Map<檔名, zip 項目>
  const thumbnails = new Map(); // 組織資料資料夾名稱 → zip 項目

  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean);
    const filename = parts.at(-1);
    if (!filename || isJunk(filename) || filename.startsWith('._') || parts[0] === '__MACOSX') continue;

    const thumb = /^(.+)_Thumbnail\.(jpe?g|png)$/i.exec(filename);
    if (thumb) {
      thumbnails.set(thumb[1], entry);
      continue;
    }
    // {資料夾}/xxx 或 {資料夾}/textures/xxx，往上找到那層資料夾名稱
    const folder = parts.length >= 2 ? parts[parts.length - (parts.at(-2) === 'textures' ? 3 : 2)] : null;
    if (!folder) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, new Map());
    byFolder.get(folder).set(filename, entry);
  }
  return { byFolder, thumbnails };
}

/** 把 zip 裡的一個檔案寫進 storage 並登錄到 files 表。 */
async function storeFromZip(dbx, filename, content, folder) {
  const key = buildStorageKey(folder, filename);
  await storage().put(key, content);
  const mime = imageMime(filename)
    ?? (/\.tiff?$/i.test(filename) ? 'image/tiff' : 'application/octet-stream');
  const row = await dbx.query(
    `insert into files (storage_key, original_name, mime_type, byte_size)
     values ($1, $2, $3, $4) returning id`,
    [key, filename, mime, content.length],
  ).then((res) => res.rows[0]);
  return row.id;
}

/**
 * 成分欄是一段文字，例如「91%SY050 + 9%SY110」或「100%SY050」。
 * 以成分「編號」對應到成分表，比例合計須為 100。
 *
 * 不用名稱比對：成分規格允許名稱重複，重名時分不出是哪一筆（10/20 確認改用編號）。
 */
function parseCompositionText(text, { byCode, byName }) {
  const raw = String(text ?? '').trim();
  if (!raw) throw badRequest('成分為必填');

  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const result = [];
  let total = 0;
  for (const part of parts) {
    const m = /^([\d.]+)\s*%\s*(.+)$/.exec(part);
    if (!m) throw badRequest(`成分「${part}」格式無法解析，預期為「50%NF010」這樣的寫法`);
    const percent = Number(m[1]);
    const code = m[2].trim();
    const id = byCode.get(code.toUpperCase());
    if (!id) {
      const suggested = byName.get(code.toLowerCase());
      throw badRequest(suggested
        ? `成分請填編號而非名稱：「${code}」請改為「${suggested}」`
        : `成分編號「${code}」在系統中不存在，請先匯入成分表`);
    }
    if (result.some((item) => item.compositionId === id)) {
      throw badRequest(`成分「${code}」在同一列重複出現，請合併比例`);
    }
    result.push({ compositionId: id, percent });
    total += percent;
  }
  if (Math.abs(total - 100) > 0.005) {
    throw badRequest(`成分比例合計須為 100%，目前為 ${total}%`);
  }
  return result;
}
