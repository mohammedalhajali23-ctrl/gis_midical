// app/api/history/route.ts
//
// الآلة الزمنية: إرجاع لقطة الحالة في لحظة محددة بالماضي.
// الاستدعاء:  /api/history?at=2026-08-04T18:30:00Z

import { getSnapshot } from '@/lib/db/queries';
import { sql } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const at = searchParams.get('at');

    // بدون وسيط: أعِد المدى الزمني المتاح ليضبط عليه المحدد الزمني
    if (!at) {
      const range = await sql`
        SELECT
          min(recorded_at) AS earliest,
          max(recorded_at) AS latest,
          count(*)::int    AS points
        FROM facility_history
      `;
      return Response.json({ ok: true, range: range[0] });
    }

    const ts = new Date(at);
    if (Number.isNaN(ts.getTime())) {
      return Response.json(
        { ok: false, error: 'صيغة التاريخ غير صالحة (استخدم ISO 8601)' },
        { status: 400 }
      );
    }

    const snapshot = await getSnapshot(ts.toISOString());

    const red = (snapshot.facilities as unknown as Array<{ status: string }>)
      .filter((f) => f.status === 'RED').length;

    return Response.json({
      ok: true,
      ...snapshot,
      summary: {
        facilities: snapshot.facilities.length,
        red,
        ambulances: snapshot.ambulances.length,
      },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
