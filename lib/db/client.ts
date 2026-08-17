// lib/db/client.ts
//
// اتصال Neon عبر HTTP بدل TCP.
// القرار الهندسي: مكتبة pg التقليدية تفتح اتصال TCP دائماً وتحتاج
// connection pooling — وهذا لا يعمل داخل بيئة Serverless حيث تُنشأ
// نسخة جديدة من الدالة مع كل طلب. @neondatabase/serverless تستخدم
// HTTP fetch، فلا pool ولا اتصالات معلّقة.
//
// التهيئة كسولة (lazy): لا يُقرأ DATABASE_URL إلا عند أول استعلام فعلي.
// هذا ضروري للنشر — متغيرات البيئة في Cloudflare Workers متاحة وقت
// التشغيل فقط، فلو قرأناها وقت الاستيراد لفشل البناء.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let cached: NeonQueryFunction<false, false> | null = null;

function getClient(): NeonQueryFunction<false, false> {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL غير معرّف. محلياً: أنشئ .env.local — على Cloudflare: npx wrangler secret put DATABASE_URL'
    );
  }
  cached = neon(url);
  return cached;
}

export const sql = ((...args: unknown[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getClient() as any)(...args)) as NeonQueryFunction<false, false>;
