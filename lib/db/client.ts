// lib/db/client.ts
//
// اتصال Neon عبر HTTP بدل TCP.
// القرار الهندسي: مكتبة pg التقليدية تفتح اتصال TCP دائماً وتحتاج
// connection pooling — وهذا لا يعمل داخل بيئة Serverless حيث تُنشأ
// نسخة جديدة من الدالة مع كل طلب. @neondatabase/serverless تستخدم
// HTTP fetch، فلا pool ولا اتصالات معلّقة.

import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL غير معرّف. أنشئ ملف .env.local وضع فيه رابط Neon.'
  );
}

export const sql = neon(process.env.DATABASE_URL);
