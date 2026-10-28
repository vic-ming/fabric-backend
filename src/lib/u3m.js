// .u3m 解析。
//
// 客戶問「只要上傳 .u3m，系統會不會把需要的檔案自動撈出來？」
// 檔案本身是一份 JSON，裡面記著每個材質通道的貼圖路徑與實際尺寸：
//
//   material.front.basecolor.texture.image = {
//     path: "textures/3-0000001_BASE.jpg",
//     width: 39.649, height: 40.339,        ← 單位是公釐
//     dpi: { x: 663.04, y: 663.04 }
//   }
//
// 伺服器讀不到使用者電腦上的檔案，沒辦法真的「自動撈」，但可以做到兩件事：
//   1. 自動把實際尺寸填進組織規格，省掉人工輸入也避免填錯
//   2. 比對這次上傳的檔案，明確告訴使用者還缺哪幾張貼圖
//
// 只有六張貼圖湊齊，前台與 CLO3D 才能正確呈現織紋，所以缺檔要擋下來。

/** .u3m 以公釐記錄尺寸，系統各處一律用公分。 */
const mmToCm = (mm) => Math.round((mm / 10) * 1000) / 1000;

/** 上傳時瀏覽器只送檔名，u3m 裡是相對路徑，比對時一律取檔名並忽略大小寫。 */
export const basename = (path) => String(path ?? '').split(/[\\/]/).pop().toLowerCase();

/**
 * @returns {null | { textures: {channel, path}[], designWidthCm, designHeightCm, previewPath }}
 *          不是合法的 u3m 就回 null，交由呼叫端決定要不要當成一般檔案收下。
 */
export function parseU3m(buffer) {
  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  const front = doc?.material?.front;
  if (!front || typeof front !== 'object') return null;

  const textures = [];
  for (const [channel, value] of Object.entries(front)) {
    const image = value?.texture?.image;
    if (image?.path) textures.push({ channel, path: image.path });
  }
  if (textures.length === 0) return null;

  // 尺寸以 basecolor 為準：那是花紋本身，其餘通道共用同一組 UV
  const base = front.basecolor?.texture?.image;
  return {
    textures,
    designWidthCm: Number.isFinite(base?.width) ? mmToCm(base.width) : null,
    designHeightCm: Number.isFinite(base?.height) ? mmToCm(base.height) : null,
    previewPath: front.preview?.path ?? null,
  };
}

/**
 * 比對 u3m 引用的貼圖與這次實際上傳的檔案。
 * @param uploadedNames 這次上傳的檔名（含 .u3m 自己）
 * @returns 缺少的貼圖檔名，空陣列代表齊了
 */
export function missingTextures(parsed, uploadedNames) {
  const have = new Set(uploadedNames.map(basename));
  return parsed.textures
    .map((t) => t.path)
    .filter((path) => !have.has(basename(path)));
}
