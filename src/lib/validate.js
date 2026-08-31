// 欄位驗證。規格書每個模組的【欄位】表都標了必填與字數上限，
// 這裡把那些規則寫成可重用的檢查函式，錯誤訊息一律用中文回給前端顯示。

import { badRequest } from './errors.js';

export function pick(source, keys) {
  const result = {};
  for (const key of keys) if (source?.[key] !== undefined) result[key] = source[key];
  return result;
}

export function requireText(value, label, maxLength, { required = true } = {}) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  if (maxLength && [...text].length > maxLength) {
    throw badRequest(`${label}不得超過 ${maxLength} 個字元`);
  }
  return text;
}

export function requireNumber(value, label, { min, max, required = true, decimals } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw badRequest(`${label}必須為數字`);
  if (min !== undefined && num < min) throw badRequest(`${label}不得小於 ${min}`);
  if (max !== undefined && num > max) throw badRequest(`${label}不得大於 ${max}`);
  if (decimals !== undefined) {
    const rounded = Number(num.toFixed(decimals));
    if (rounded !== num) throw badRequest(`${label}最多 ${decimals} 位小數`);
  }
  return num;
}

export function requireInt(value, label, { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num)) throw badRequest(`${label}必須為整數`);
  return num;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function requireDate(value, label, { required = true } = {}) {
  if (!value) {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const text = String(value).slice(0, 10);
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw badRequest(`${label}格式須為 YYYY-MM-DD`);
  }
  return text;
}

export function requireOneOf(value, label, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`${label}須為 ${allowed.join('、')} 其中之一`);
  }
  return value;
}

export function requireIdArray(value, label) {
  if (!Array.isArray(value)) throw badRequest(`${label}格式錯誤`);
  const ids = value.map((item) => Number(item)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/** 分頁參數。規格書各清單畫面皆有「第 1/N 頁」的分頁列。 */
export function parsePaging(query, { defaultSize = 10, maxSize = 200 } = {}) {
  const page = Math.max(1, Number(query?.page) || 1);
  const size = Math.min(maxSize, Math.max(1, Number(query?.pageSize) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export function pageResult(rows, total, { page, size }) {
  return {
    items: rows,
    page,
    pageSize: size,
    total: Number(total),
    totalPages: Math.max(1, Math.ceil(Number(total) / size)),
  };
}
