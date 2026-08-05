// app/api/incidents/route.ts
//
// إنشاء بلاغ عند نقطة يحددها المدير على الخريطة، ثم تشغيل المخطط
// الانسيابي عليه مباشرة. هذا هو المدخل البشري للنظام مقابل المحاكاة.

import { z } from 'zod';
import { sql } from '@/lib/db/client';
import { createDbDataSource } from '@/lib/db/queries';
import { runDispatchFlow } from '@/lib/dispatch/engine';
import type { Incident } from '@/types';

export const dynamic = 'force-dynamic';

const Body = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  severity: z.number().int().min(1).max(5).default(3),
  description: z.string().min(2).max(200).default('طلب إسعاف يدوي'),
  autoDispatch: z.boolean().default(true),
});

export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'مدخلات غير صالحة', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { lat, lon, severity, description, autoDispatch } = parsed.data;

    // ST_Within يحدد المحافظة تلقائياً من إحداثيات النقرة
    const rows = await sql`
      INSERT INTO incidents (location, governorate_id, severity, description)
      SELECT
        ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
        (SELECT g.id FROM governorates g
          WHERE ST_Within(
            ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
            g.boundary
          )
          LIMIT 1),
        ${severity},
        ${description}
      RETURNING id, severity, description,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lon
    `;
    const incident = rows[0] as unknown as Incident;

    if (!autoDispatch) {
      return Response.json({ ok: true, incident, outcome: null });
    }

    const outcome = await runDispatchFlow(incident, createDbDataSource());
    return Response.json({ ok: true, incident, outcome });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
