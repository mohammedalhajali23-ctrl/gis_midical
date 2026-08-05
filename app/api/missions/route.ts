// app/api/missions/route.ts
//
// دورة حياة المهمة — هنا تُغلق الحلقة [F] → [A] في المخطط:
// وصول السيارة يشغل سريراً، فتتغيّر نسبة الإشغال، فيُعاد تقييم اللون.
//
//   arrive   السيارة وصلت موقع الحادث   → transporting
//   complete سُلّم المريض للمنشأة        → السيارة available + سرير مشغول
//   cancel   إلغاء المهمة                → السيارة available بلا تغيير أسرّة

import { z } from 'zod';
import { sql } from '@/lib/db/client';
import { evaluateFacilityStatus } from '@/lib/dispatch/engine';

export const dynamic = 'force-dynamic';

const Body = z.object({
  missionId: z.string().uuid(),
  action: z.enum(['arrive', 'complete', 'cancel']),
});

export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'مدخلات غير صالحة' },
        { status: 400 }
      );
    }
    const { missionId, action } = parsed.data;

    const found = await sql`
      SELECT m.id, m.state, m.ambulance_id, m.facility_id, m.incident_id,
             f.name AS facility_name, f.total_beds, f.occupied_beds,
             a.code AS ambulance_code
      FROM missions m
      JOIN facilities f ON f.id = m.facility_id
      JOIN ambulances a ON a.id = m.ambulance_id
      WHERE m.id = ${missionId}::uuid
    `;
    if (found.length === 0) {
      return Response.json({ ok: false, error: 'المهمة غير موجودة' }, { status: 404 });
    }
    const m = found[0] as {
      state: string; ambulance_id: string; facility_id: string;
      incident_id: string; facility_name: string;
      total_beds: number; occupied_beds: number; ambulance_code: string;
    };

    // ---------------- وصول السيارة إلى موقع الحادث ----------------
    if (action === 'arrive') {
      await sql`
        UPDATE missions SET state = 'arrived' WHERE id = ${missionId}::uuid
      `;
      await sql`
        UPDATE ambulances SET state = 'transporting', updated_at = now()
        WHERE id = ${m.ambulance_id}::uuid
      `;
      return Response.json({
        ok: true,
        action,
        message: `${m.ambulance_code} وصلت الموقع وتنقل الحالة إلى ${m.facility_name}`,
      });
    }

    // ---------------- إلغاء ----------------
    if (action === 'cancel') {
      await sql`
        UPDATE missions SET state = 'cancelled', completed_at = now()
        WHERE id = ${missionId}::uuid
      `;
      await sql`
        UPDATE ambulances SET state = 'available', updated_at = now()
        WHERE id = ${m.ambulance_id}::uuid
      `;
      await sql`
        UPDATE incidents SET state = 'pending' WHERE id = ${m.incident_id}::uuid
      `;
      return Response.json({
        ok: true,
        action,
        message: `أُلغيت المهمة وعادت ${m.ambulance_code} للخدمة`,
      });
    }

    // ---------------- إنجاز: تسليم المريض ----------------
    await sql`
      UPDATE missions SET state = 'completed', completed_at = now()
      WHERE id = ${missionId}::uuid
    `;

    // السيارة تعود متاحة
    await sql`
      UPDATE ambulances SET state = 'available', updated_at = now()
      WHERE id = ${m.ambulance_id}::uuid
    `;

    // [A] سرير يُشغل — التريغر يؤرشف التغيير تلقائياً
    const updated = await sql`
      UPDATE facilities
      SET occupied_beds = LEAST(total_beds, occupied_beds + 1),
          updated_at = now()
      WHERE id = ${m.facility_id}::uuid
      RETURNING total_beds, occupied_beds
    `;
    const f = updated[0] as { total_beds: number; occupied_beds: number };

    // [B] إعادة تقييم الحالة اللونية بعد تغيّر الإشغال
    const evaluation = evaluateFacilityStatus(f.total_beds, f.occupied_beds);
    await sql`
      UPDATE facilities
      SET status = ${evaluation.status}::facility_status
      WHERE id = ${m.facility_id}::uuid
    `;

    // [C] تنبيه إن تجاوزت المنشأة العتبة نتيجة هذا الاستقبال
    if (evaluation.status === 'RED') {
      await sql`
        INSERT INTO alerts (facility_id, level, message)
        VALUES (
          ${m.facility_id}::uuid,
          'CRITICAL',
          ${`${m.facility_name} تجاوزت 90% إشغال بعد استقبال حالة جديدة (${evaluation.occupancyPct.toFixed(1)}%)`}
        )
      `;
    }

    await sql`
      UPDATE incidents SET state = 'resolved', resolved_at = now()
      WHERE id = ${m.incident_id}::uuid
    `;

    return Response.json({
      ok: true,
      action,
      facility: m.facility_name,
      beds: `${f.occupied_beds}/${f.total_beds}`,
      occupancyPct: +evaluation.occupancyPct.toFixed(1),
      status: evaluation.status,
      message: `سُلّمت الحالة إلى ${m.facility_name} — الإشغال ${evaluation.occupancyPct.toFixed(1)}% (${evaluation.status}) · ${m.ambulance_code} عادت للخدمة`,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
