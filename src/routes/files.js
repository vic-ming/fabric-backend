// 檔案讀取。
// 網址帶的是不可預測的 storage_key，且素材要能直接放進 <img src> / 3D loader，
// 因此此端點不驗 token；真正的存取控制在寫入端（僅管理者可上傳／刪除）。
// 若日後需要嚴格控管，改為簽章網址即可，路徑格式不變。

import { getFileByKey } from '../lib/files.js';
import { storage } from '../storage/index.js';

export default async function fileRoutes(app) {
  app.get('/api/files/*', async (request, reply) => {
    const key = request.params['*'];
    const file = await getFileByKey(key);
    const stream = await storage().stream(file.storage_key);

    reply.header('Content-Type', file.mime_type);
    reply.header('Content-Length', String(file.byte_size));
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    );
    return reply.send(stream);
  });
}
