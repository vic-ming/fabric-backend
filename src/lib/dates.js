// 日期處理。
//
// 兩個容易出錯的點：
// 1. 驅動回傳的 date 欄位可能是 Date 物件，String(date) 會得到
//    "Tue Aug 25 2026 ..." 而非 ISO，直接 slice 會拿到錯誤的字串。
// 2. 「今天」若用 UTC 計算，台灣時間凌晨 0~8 點會落到前一天，
//    造成帳號生效起日當天無法登入。
// 因此一律經由此處轉換，時區以 config.timezone 為準（預設 Asia/Taipei），
// 且資料庫連線也設成同一時區，讓 SQL 的 current_date 與這裡一致。

import { config } from '../config.js';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 把任意日期值正規化成 YYYY-MM-DD。 */
export function toDateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatter.format(value);
  const text = String(value);
  // 已是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss 形式
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatter.format(parsed);
}

/** 依設定時區取得今天的 YYYY-MM-DD。 */
export const today = () => formatter.format(new Date());
