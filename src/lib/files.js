// 上傳檔案的共用處理：把 multipart 的檔案寫進 storage，並在 files 表登錄一筆。

import { config } from '../config.js';
import { one, query } from '../db/index.js';
import { buildStorageKey, storage } from '../storage/index.js';
import { badRequest, notFound } from './errors.js';

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * @param part  @fastify/multipart 的 file part
 * @param folder 儲存子目錄，例如 'patterns'
 * @param allowedMime 若給定則限制 MIME；不給代表不限格式（規格書：組織資料不限檔案格式）
 */
export async function saveUpload(part, folder, allowedMime = null) {
  const buffer = await part.toBuffer();
  if (buffer.length === 0) throw badRequest('上傳檔案為空');
  if (buffer.length > config.maxUploadBytes) {
    throw badRequest(`檔案大小超過上限 ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
  }
  const mime = part.mimetype || 'application/octet-stream';
  if (allowedMime && !allowedMime.includes(mime)) {
    throw badRequest(`不支援的檔案格式：${mime}`);
  }

  const key = buildStorageKey(folder, part.filename ?? 'file');
  await storage().put(key, buffer);

  return one(
    `insert into files (storage_key, original_name, mime_type, byte_size)
     values ($1, $2, $3, $4) returning *`,
    [key, part.filename ?? 'file', mime, buffer.length],
  );
}

export async function removeFile(fileId) {
  if (!fileId) return;
  const file = await one('select * from files where id = $1', [fileId]);
  if (!file) return;
  await storage().remove(file.storage_key).catch(() => {});
  await query('delete from files where id = $1', [fileId]);
}

export async function getFileByKey(key) {
  const file = await one('select * from files where storage_key = $1', [key]);
  if (!file) throw notFound('檔案不存在');
  return file;
}

/** 統一輸出給前端的檔案欄位。 */
export function fileView(row, prefix = '') {
  const key = row[`${prefix}storage_key`];
  if (!key) return null;
  return {
    id: row[`${prefix}file_id`] ?? row[`${prefix}id`],
    url: `/api/files/${key}`,
    name: row[`${prefix}original_name`],
    mimeType: row[`${prefix}mime_type`],
    byteSize: row[`${prefix}byte_size`] !== undefined ? Number(row[`${prefix}byte_size`]) : undefined,
  };
}
