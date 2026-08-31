import { accountStatus, authenticate, isWithinValidPeriod, roleOf, signToken, verifyPassword } from '../lib/auth.js';
import { one } from '../db/index.js';
import { toDateString } from '../lib/dates.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { requireText } from '../lib/validate.js';

export default async function authRoutes(app) {
  app.post('/api/auth/login', async (request) => {
    const username = requireText(request.body?.username, '帳號', 50);
    const password = requireText(request.body?.password, '密碼', 50);

    const account = await one(
      `select a.*, c.name as customer_name
         from accounts a
         left join customers c on c.id = a.customer_id
        where a.username = $1`,
      [username],
    );
    // 不區分「帳號不存在」與「密碼錯誤」，避免帳號列舉
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      throw unauthorized('帳號或密碼錯誤');
    }
    if (!isWithinValidPeriod(account)) {
      throw forbidden('帳號不在生效期間內，請聯絡管理者');
    }

    return {
      token: signToken(account),
      user: {
        id: account.id,
        username: account.username,
        displayName: account.display_name,
        role: roleOf(account),
        customerId: account.customer_id,
        customerName: account.customer_name ?? '系統管理者',
        validFrom: toDateString(account.valid_from),
        validTo: toDateString(account.valid_to),
        status: accountStatus(account),
      },
    };
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => request.user);
}
