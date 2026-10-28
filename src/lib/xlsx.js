// 最小的 .xlsx 讀取器：把第一張工作表轉成以標題列為鍵的物件陣列。
//
// 只做批次匯入需要的事 —— 讀字串與數字，不處理公式結果以外的運算、
// 不處理日期格式（匯入的四種表單都沒有日期欄位）。
//
// .xlsx 是一個 zip，裡面是 XML：
//   xl/worksheets/sheet1.xml  儲存格，字串型別的值是 sharedStrings 的索引
//   xl/sharedStrings.xml      共用字串表
//
// 刻意不引入 XML 解析套件：這兩份 XML 的結構固定且簡單，用正規式取值即可，
// 也維持住「相依套件全是純 JS」這個讓程式跑得動在客戶共享主機上的前提。

import { readZip } from './zip.js';

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');   // & 要最後還原，否則 &amp;lt; 會被解兩次

/** 共用字串表。一個 <si> 可能被拆成多個 <t>（中間有格式變化），要串起來。 */
function readSharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) =>
    [...si.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => decodeEntities(t)).join(''));
}

/** A1 → 0、B1 → 1、AA1 → 26 */
function columnIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * @returns {{ headers: string[], rows: object[] }}
 *          rows 以標題文字為鍵；整列皆空的會被略過（Excel 常留下大量空列）。
 */
export function readSheet(buffer) {
  const files = readZip(buffer);
  const shared = readSharedStrings(files);

  const sheetPath = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!sheetPath) throw new Error('Excel 檔裡找不到工作表');
  const xml = files.get(sheetPath).toString('utf8');

  const table = [];
  for (const [, rowXml] of xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    // 空白但有格式的儲存格是自閉合的 <c r="J2" s="2"/>（在 Excel 清掉內容就會這樣），
    // 必須與 <c ...>...</c> 分開比對，否則會把後面幾格一起吞掉，讀成空值。
    for (const m of rowXml.matchAll(/<c\s+([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const attrs = m[1];
      const body = m[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const i = Number(/<v>(.*?)<\/v>/s.exec(body)?.[1]);
        value = shared[i] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => decodeEntities(t)).join('');
      } else {
        const raw = /<v>(.*?)<\/v>/s.exec(body)?.[1];
        value = raw === undefined ? '' : decodeEntities(raw);
      }
      cells[index] = value;
    }
    table.push(cells);
  }

  if (table.length === 0) return { headers: [], rows: [] };

  const headers = (table[0] ?? []).map((h) => String(h ?? '').trim());
  const rows = [];
  for (const cells of table.slice(1)) {
    if (!cells || cells.every((c) => c === undefined || String(c).trim() === '')) continue;
    const row = {};
    headers.forEach((h, i) => { if (h) row[h] = cells[i] === undefined ? '' : String(cells[i]).trim(); });
    rows.push(row);
  }
  return { headers, rows };
}
