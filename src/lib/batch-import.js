// 批次匯入的共用骨架。
//
// 四張匯入表（Pantone／成分／組織代碼／組織）共用三條規則，規格書逐頁重複寫了三次：
//   1. 公司名稱為 TTRI 的，是給所有平台使用者使用的資料 → 對應系統的「全域」
//   2. 編號重複就提示那些已有資料，不進行覆蓋
//   3. 失敗時回傳失敗的錯誤訊息與資料編號；沒有錯誤的資料更新，有錯誤的不予更新
//
// 第 3 點決定了實作方式：不能整批包在一個交易裡，否則一列出錯就全部回滾。
// 改成逐列各自寫入，錯誤收集起來一起回報。

import { many } from '../db/index.js';
import { badRequest } from './errors.js';

/** 匯入檔用這個名稱代表「全平台共用」。 */
export const GLOBAL_COMPANY = 'TTRI';

/**
 * 公司名稱 → 適用對象。
 * 先把公司清單整個讀進來比對，避免每一列各查一次資料庫（Pantone 有近兩千列）。
 */
export async function createScopeResolver() {
  const customers = await many('select id, name from customers');
  const byName = new Map(customers.map((c) => [c.name.trim(), c.id]));

  return function resolveScope(companyName) {
    const name = String(companyName ?? '').trim();
    if (!name) throw badRequest('公司名稱為必填');
    if (name.toUpperCase() === GLOBAL_COMPANY) {
      return { scopeType: 'global', customerIds: [] };
    }
    const id = byName.get(name);
    if (!id) throw badRequest(`公司名稱「${name}」在系統中不存在，請先於公司管理建立`);
    return { scopeType: 'customers', customerIds: [id] };
  };
}

/**
 * 逐列執行匯入。
 *
 * @param rows     readSheet 產出的資料列
 * @param codeOf   取出該列的編號，用於錯誤回報
 * @param handler  async (row, index) => 'imported' | 'skipped'
 *                 要跳過（編號已存在）就回 'skipped'，丟出例外則計為失敗
 * @param keyOf    判斷「檔內重複」用的鍵，預設同編號。
 *                 Pantone 是「系列＋色號」才算重複，印花是檔名。
 * @param skipReason 回 'skipped' 時顯示的原因
 * @returns {{ total, imported, skipped: [], failed: [] }}
 */
export async function runImport(rows, codeOf, handler, {
  keyOf = codeOf, skipReason = '編號已存在，未覆蓋',
} = {}) {
  const result = { total: rows.length, imported: 0, skipped: [], failed: [] };

  // 同一份檔案內編號重複：無從判斷哪一列才對，所以重複的每一列都不匯入（10/20 確認）。
  // 比對不分大小寫，與各表以編號查找時的規則一致。
  const rowsByCode = new Map();
  for (const [index, row] of rows.entries()) {
    if (!String(codeOf(row) ?? '').trim()) continue; // 空白編號交給 handler 回報「為必填」
    const key = String(keyOf(row) ?? '').trim().toUpperCase();
    rowsByCode.set(key, [...(rowsByCode.get(key) ?? []), index + 2]);
  }

  for (const [index, row] of rows.entries()) {
    const code = String(codeOf(row) ?? '').trim();
    const sameCodeRows = code ? rowsByCode.get(String(keyOf(row) ?? '').trim().toUpperCase()) ?? [] : [];
    if (sameCodeRows.length > 1) {
      result.failed.push({
        row: index + 2,
        code,
        error: `編號在匯入檔內重複（第 ${sameCodeRows.join('、')} 列），重複的資料皆不匯入`,
      });
      continue;
    }
    try {
      const outcome = await handler(row, index);
      if (outcome === 'skipped') {
        result.skipped.push({ code, reason: skipReason });
      } else {
        result.imported += 1;
      }
    } catch (error) {
      result.failed.push({
        // Excel 的列號：標題佔第 1 列，所以資料從第 2 列開始
        row: index + 2,
        code,
        error: error.message ?? String(error),
      });
    }
  }
  return result;
}

/** 匯入檔必須含有這些欄位，缺了直接整份擋下，不逐列報錯。 */
export function assertColumns(headers, required, label) {
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length > 0) {
    throw badRequest(`${label}匯入檔缺少欄位：${missing.join('、')}`);
  }
}

/** Excel 的數字常帶 .0（例如 239.0），轉整數時要先過一次 Number。 */
export function toInt(value, label, { required = true, min, max } = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) throw badRequest(`${label}必須為數字（收到「${raw}」）`);
  const int = Math.round(num);
  if (min !== undefined && int < min) throw badRequest(`${label}不得小於 ${min}`);
  if (max !== undefined && int > max) throw badRequest(`${label}不得大於 ${max}`);
  return int;
}

export function toNumber(value, label, { required = true, min, max } = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) throw badRequest(`${label}必須為數字（收到「${raw}」）`);
  if (min !== undefined && num < min) throw badRequest(`${label}不得小於 ${min}`);
  if (max !== undefined && num > max) throw badRequest(`${label}不得大於 ${max}`);
  return num;
}

export function toText(value, label, maxLength, { required = true } = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  if (raw.length > maxLength) throw badRequest(`${label}不得超過 ${maxLength} 字`);
  return raw;
}

/** R/G/B → #rrggbb，畫面直接拿來上色。 */
export function rgbToHex(r, g, b) {
  const part = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}
