// app/api/tick/route.ts
//
// نبضة المحاكاة. تُستدعى من الواجهة كل بضع ثوانٍ (مؤقتاً)، وستُستبدل
// في الخطوة 6 بدفع فوري عبر Cloudflare Durable Object.

import { tick } from '@/lib/simulation/simulator';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const seedParam = searchParams.get('seed');
    const seed = seedParam ? Number(seedParam) : Date.now();

    const result = await tick(seed);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// GET للتجربة السريعة من المتصفح
export async function GET(req: Request) {
  return POST(req);
}
