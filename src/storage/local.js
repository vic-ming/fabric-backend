import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../config.js';

export function createLocalStorage() {
  const root = resolve(config.uploadDir);

  const pathFor = (key) => {
    const target = resolve(root, normalize(key));
    // 擋掉 ../ 之類的跳脫，避免寫到 uploads/ 之外
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`不合法的儲存路徑：${key}`);
    }
    return target;
  };

  return {
    kind: 'local',
    async init() {
      await mkdir(root, { recursive: true });
    },
    async put(key, buffer) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);
      return { key, size: buffer.length };
    },
    async stream(key) {
      const target = pathFor(key);
      await stat(target);
      return createReadStream(target);
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
    publicUrl(key) {
      return `/api/files/${key}`;
    },
  };
}
