// app/api/dispatch/route.ts
//
// وضعان:
//  1. auto   — تشغيل المخطط الانسيابي على بلاغ قائم
//  2. manual — قرار يدوي من المدير يتجاوز بوابة الـ90%
//
// السماح بالتجاوز اليدوي مطلب صريح في الوثيقة ("واجهة تتيح للمدير
// اتخاذ قرارات يدوية"). يُسجَّل بعلم is_manual_override للتدقيق،
// لأن تجاوز حد السعة في سياق طبي قرار بشري يجب أن يكون قابلاً للتتبّع.

import { z } from 'zod';
import { sql } from '@/lib/db/client';
import { createDbDataSource } from '@/lib/db/queries';
import { runDispatchFlow, evaluateFacilityStatus } from '@/lib/dispatch/engine';
import type { Incident } from '@/types';

export const dynamic = 'force-dynamic';

const AutoSchema = z.object({
  mode: z.literal('auto'),
  incidentId: z.string().uuid(),
});

const ManualSchema = z.object({
  mode: z.literal('manual'),
  incidentId: z.string().uuid(),
  ambulanceId: z.string().uuid(),
  facilityId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

const BodySchema = z.discriminatedUnion('mode', [AutoSchema, ManualSchema]);

export async function POST(req: Request) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'مدخلات غير صالحة', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const body = parsed.data;

    // جلب البلاغ
    const rows = await sql`
      SELECT id, severity, description,
             ST_Y(location::geometry) AS lat,
             ST_X(location::geometry) AS lon
      FROM incidents
      WHERE id = ${body.incidentId}::uuid
    `;
    if (rows.length === 0) {
      return Response.json({ ok: false, error: 'البلاغ غير موجود' }, { status: 404 });
    }
    const incident = rows[0] as unknown as Incident;

    // ------------------------------------------------------------------
    // الوضع التلقائي — المخطط الانسيابي كما هو
    // ------------------------------------------------------------------
    if (body.mode === 'auto') {
      const outcome = await runDispatchFlow(incident, createDbDataSource());
      return Response.json({ ok: true, mode: 'auto', outcome });
    }

    // ------------------------------------------------------------------
    // الوضع اليدوي — تجاوز صريح لبوابة [B]
    // ------------------------------------------------------------------
    const target = await sql`
      SELECT f.id, f.name, f.total_beds, f.occupied_beds,
             ST_Distance(f.location, i.location) AS facility_distance,
             ST_Distance(a.location, i.location) AS ambulance_distance,
             a.state AS ambulance_state
      FROM facilities f, ambulances a, incidents i
      WHERE f.id = ${body.facilityId}::uuid
        AND a.id = ${body.ambulanceId}::uuid
        AND i.id = ${body.incidentId}::uuid
    `;
    if (target.length === 0) {
      return Response.json(
        { ok: false, error: 'المنشأة أو السيارة غير موجودة' },
        { status: 404 }
      );
    }
    const t = target[0] as {
      id: string; name: string;
      total_beds: number; occupied_beds: number;
      facility_distance: string; ambulance_distance: string;
      ambulance_state: string;
    };

    if (t.ambulance_state !== 'available') {
      return Response.json(
        { ok: false, error: `السيارة غير متاحة (${t.ambulance_state})` },
        { status: 409 }
      );
    }

    const evaluation = evaluateFacilityStatus(t.total_beds, t.occupied_beds);
    const distance = Number(t.ambulance_distance) + Number(t.facility_distance);
    const etaSeconds = Math.round(distance / 13.9);

    await sql`
      INSERT INTO missions (
        incident_id, ambulance_id, facility_id, route,
        distance_meters, eta_seconds, attempt_count, is_manual_override
      )
      SELECT
        i.id, a.id, f.id,
        ST_MakeLine(ARRAY[
          a.location::geometry, i.location::geometry, f.location::geometry
        ])::geography,
        ${distance}, ${etaSeconds}, 1, TRUE
      FROM incidents i, ambulances a, facilities f
      WHERE i.id = ${body.incidentId}::uuid
        AND a.id = ${body.ambulanceId}::uuid
        AND f.id = ${body.facilityId}::uuid
    `;

    await sql`
      UPDATE ambulances SET state = 'en_route', updated_at = now()
      WHERE id = ${body.ambulanceId}::uuid
    `;
    await sql`
      UPDATE incidents SET state = 'assigned' WHERE id = ${body.incidentId}::uuid
    `;

    // أثر تدقيقي إذا تجاوز المدير منشأة حمراء
    if (evaluation.status === 'RED') {
      await sql`
        INSERT INTO alerts (facility_id, incident_id, level, message)
        VALUES (
          ${body.facilityId}::uuid,
          ${body.incidentId}::uuid,
          'OVERRIDE',
          ${`تجاوز يدوي: أُرسلت حالة إلى ${t.name} رغم إشغال ${evaluation.occupancyPct.toFixed(1)}% — السبب: ${body.reason}`}
        )
      `;
    }

    return Response.json({
      ok: true,
      mode: 'manual',
      outcome: {
        status: 'DISPATCHED',
        facilityId: t.id,
        facilityName: t.name,
        distanceMeters: distance,
        etaSeconds,
        overrodeCapacityGate: evaluation.status === 'RED',
        occupancyPct: +evaluation.occupancyPct.toFixed(1),
        reason: body.reason,
      },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
