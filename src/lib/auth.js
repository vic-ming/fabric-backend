// 認證與權限。
//
// 規格書 3、預設權限規劃：
//   一般使用者 User  — 登入前台
//   後台管理者 Admin — 登入後台
// 帳號管理的「公司名稱」清單為「客戶 + 系統管理者」，選到系統管理者即為
// 本系統的管理員帳號。因此角色不另設欄位，直接由 customer_id 是否為 NULL 判定。

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db/index.js';
import { toDateString, today } from './dates.js';
import { forbidden, unauthorized } from './errors.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export const roleOf = (account) => (account.customer_id === null ? 'admin' : 'user');

export function signToken(account) {
  return jwt.sign(
    { sub: account.id, username: account.username, role: roleOf(account), customerId: account.customer_id },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/** 帳號僅於生效期間內可登入，迄日次日起自動失效。 */
export function isWithinValidPeriod(account, day = today()) {
  const from = toDateString(account.valid_from);
  const to = toDateString(account.valid_to);
  return day >= from && day <= to;
}

export const accountStatus = (account) => (isWithinValidPeriod(account) ? 'active' : 'inactive');

function readToken(request) {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Fastify preHandler：驗證 token 並把帳號掛到 request.user。 */
export async function authenticate(request) {
  const token = readToken(request);
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('登入已過期，請重新登入');
  }

  const account = await one(
    `select a.*, c.name as customer_name
       from accounts a
       left join customers c on c.id = a.customer_id
      where a.id = $1`,
    [payload.sub],
  );
  if (!account) throw unauthorized('帳號已不存在');
  if (!isWithinValidPeriod(account)) throw forbidden('帳號已逾生效期間');

  request.user = {
    id: account.id,
    username: account.username,
    displayName: account.display_name,
    role: roleOf(account),
    customerId: account.customer_id,
    customerName: account.customer_name ?? '系統管理者',
  };
}

/** Fastify preHandler：僅限後台管理者。 */
export async function requireAdmin(request) {
  await authenticate(request);
  if (request.user.role !== 'admin') throw forbidden('此功能僅限系統管理者使用');
}
