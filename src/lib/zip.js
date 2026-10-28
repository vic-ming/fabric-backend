// 最小的 zip 讀取器。
//
// 兩個地方需要它：.xlsx 本身就是一個 zip，批次匯入組織／印花時的素材包也是 zip。
// 專案的相依套件目前全是純 JavaScript／WASM，沒有需要編譯的原生模組，
// 這點讓它能裝在客戶那台只有 cPanel 的共享主機上；為了不破壞這個前提，
// 這裡自己讀 zip，而不是為了解壓多拉一個套件進來。
//
// 兩種讀法：
//   readZip(buffer)      整包已在記憶體（.xlsx，很小），一次解開全部
//   openZipFile(path)    素材包可能好幾 GB（客戶的資料量大，10/22），只讀目錄，
//                        要用哪個檔才去磁碟讀那一段，記憶體用量與 zip 大小無關
//
// 只支援 store（不壓縮）與 deflate 這兩種方法，一般工具產出的 zip 都在此範圍。
// 支援 zip64（超過 4 GB 或超過 65535 個檔案時，壓縮工具會自動改用這個格式）。

import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;        // 中央目錄結尾
const CEN_SIG = 0x02014b50;         // 中央目錄項目
const LOC_SIG = 0x04034b50;         // 本地檔頭
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX32 = 0xffffffff;

// 中央目錄結尾 22 bytes + 註解最長 65535，前面再緊接 zip64 locator 20 bytes
const TAIL_SIZE = 22 + 0xffff + 20;

/** 從尾端往前找中央目錄結尾，回傳在 tail 內的位置。 */
function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是有效的 zip 檔（找不到中央目錄）');
}

/**
 * 讀出中央目錄的位置。zip64 的話真正的值在另一個記錄裡，
 * 回傳 zip64RecordOffset 讓呼叫端去讀那 56 bytes。
 */
function readEocd(tail, at) {
  const info = {
    count: tail.readUInt16LE(at + 10),
    cdSize: tail.readUInt32LE(at + 12),
    cdOffset: tail.readUInt32LE(at + 16),
    zip64RecordOffset: null,
  };
  if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR_SIG) {
    info.zip64RecordOffset = Number(tail.readBigUInt64LE(at - 20 + 8));
  }
  return info;
}

function readZip64Eocd(record) {
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('zip64 中央目錄結尾損毀');
  return {
    count: Number(record.readBigUInt64LE(32)),
    cdSize: Number(record.readBigUInt64LE(40)),
    cdOffset: Number(record.readBigUInt64LE(48)),
  };
}

/** zip64 的大小與位移放在 extra 欄位裡，只有主欄位填 0xFFFFFFFF 的才會出現、且依序排列。 */
function applyZip64Extra(entry, extra) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === ZIP64_EXTRA_ID) {
      let q = p + 4;
      if (entry.size === MAX32) { entry.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.compressedSize === MAX32) { entry.compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === MAX32) { entry.localOffset = Number(extra.readBigUInt64LE(q)); }
      return;
    }
    p += 4 + size;
  }
}

/** 解析中央目錄。目錄項目（以 / 結尾）不列入。 */
function parseCentralDirectory(cd, count) {
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) break;
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const entry = {
      // zip 規格要求檔名以 UTF-8 存放（bit 11），實務上工具都這麼做
      name: cd.toString('utf8', p + 46, p + 46 + nameLength),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    };
    if (entry.compressedSize === MAX32 || entry.size === MAX32 || entry.localOffset === MAX32) {
      applyZip64Extra(entry, cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));
    }
    if (!entry.name.endsWith('/')) entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflate(entry, raw) {
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`壓縮檔 ${entry.name} 使用了不支援的壓縮方式（${entry.method}）`);
}

/** 本地檔頭的 extra 欄位長度可能與中央目錄不同，資料起點一定要從本地檔頭重算。 */
function dataStartOf(entry, localHeader) {
  if (localHeader.readUInt32LE(0) !== LOC_SIG) throw new Error(`壓縮檔 ${entry.name} 的檔頭損毀`);
  return entry.localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
}

/**
 * @param buffer zip 檔內容
 * @returns Map<檔案路徑, Buffer>。目錄項目不會出現在結果裡。
 */
export function readZip(buffer) {
  const tailStart = Math.max(0, buffer.length - TAIL_SIZE);
  const tail = buffer.subarray(tailStart);
  let info = readEocd(tail, findEocd(tail));
  if (info.zip64RecordOffset !== null) {
    info = readZip64Eocd(buffer.subarray(info.zip64RecordOffset, info.zip64RecordOffset + 56));
  }
  const entries = parseCentralDirectory(buffer.subarray(info.cdOffset, info.cdOffset + info.cdSize), info.count);

  const files = new Map();
  for (const entry of entries) {
    const start = dataStartOf(entry, buffer.subarray(entry.localOffset, entry.localOffset + 30));
    files.set(entry.name, inflate(entry, buffer.subarray(start, start + entry.compressedSize)));
  }
  return files;
}

/**
 * 開啟磁碟上的 zip，只讀中央目錄。
 * @returns {{ entries: {name, size}[], read(entry): Promise<Buffer>, close(): Promise<void> }}
 *          用完務必 close。
 */
export async function openZipFile(path) {
  const handle = await open(path, 'r');
  const readAt = async (position, length) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, position);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  };

  try {
    const { size } = await handle.stat();
    const tailStart = Math.max(0, size - TAIL_SIZE);
    const tail = await readAt(tailStart, size - tailStart);
    let info = readEocd(tail, findEocd(tail));
    if (info.zip64RecordOffset !== null) info = readZip64Eocd(await readAt(info.zip64RecordOffset, 56));
    const entries = parseCentralDirectory(await readAt(info.cdOffset, info.cdSize), info.count);

    return {
      entries,
      async read(entry) {
        const start = dataStartOf(entry, await readAt(entry.localOffset, 30));
        return inflate(entry, await readAt(start, entry.compressedSize));
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
