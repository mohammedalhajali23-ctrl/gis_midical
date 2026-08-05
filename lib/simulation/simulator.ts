// lib/simulation/simulator.ts
//
// محرك محاكاة حتمي (seeded) بديلاً عن استدعاء نموذج ذكاء اصطناعي في كل نبضة.
// السبب (يُذكر في README): استدعاء LLM لكل تحديث = بطء + تكلفة + نتائج غير
// قابلة لإعادة الإنتاج. المحاكاة الحتمية تعطي نفس السيناريو لنفس البذرة،
// فتصبح الأخطاء قابلة للتكرار والتصحيح. يمكن استخدام LLM اختيارياً لتوليد
// نص وصف الحادث فقط، لا لمنطق الحركة.

import { sql } from '@/lib/db/client';
import { createDbDataSource } from '@/lib/db/queries';
import { runDispatchFlow } from '@/lib/dispatch/engine';
import type { Incident } from '@/types';

/** مولّد أرقام شبه عشوائي قابل للتكرار (Mulberry32) */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rng: () => number, arr: T[]): T =>
  arr[Math.floor(rng() * arr.length)];

const SCENARIOS = [
  'حادث سير على الطريق الدولي',
  'انهيار مبنى سكني',
  'حالة قلبية طارئة',
  'إصابة عمل في منشأة صناعية',
  'حالة اختناق — تسرّب غاز',
  'إصابات متعددة — انفجار',
  'ولادة متعسّرة',
  'تسمّم غذائي جماعي',
];

// ---------------------------------------------------------------------
// 1. توليد بلاغ جديد داخل حدود محافظة عشوائية
// ---------------------------------------------------------------------
export async function spawnIncident(rng: () => number) {
  const severity = 1 + Math.floor(rng() * 5);
  const description = pick(rng, SCENARIOS);
  const rx = rng();
  const ry = rng();

  const rows = await sql`
    WITH g AS (
      SELECT id, boundary FROM governorates ORDER BY random() LIMIT 1
    )
    INSERT INTO incidents (location, governorate_id, severity, description)
    SELECT
      ST_SetSRID(ST_MakePoint(
        ST_XMin(boundary) + ${rx} * (ST_XMax(boundary) - ST_XMin(boundary)),
        ST_YMin(boundary) + ${ry} * (ST_YMax(boundary) - ST_YMin(boundary))
      ), 4326)::geography,
      id, ${severity}, ${description}
    FROM g
    RETURNING id,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lon,
              severity, description
  `;
  return rows[0] as unknown as Incident;
}

// ---------------------------------------------------------------------
// 2. تحريك السيارات المُرسَلة على مسارها
// ---------------------------------------------------------------------
/**
 * ST_LineInterpolatePoint ينقل السيارة إلى نسبة محددة من طول المسار.
 * كل نبضة تتقدّم السيارة خطوة ثابتة، وعند بلوغ النهاية تكتمل المهمة.
 */
export async function advanceMissions(stepFraction = 0.12) {
  // تقدّم السيارات على مساراتها
  await sql`
    UPDATE ambulances a
    SET location = ST_LineInterpolatePoint(
                     m.route::geometry,
                     LEAST(1.0, ${stepFraction} * m.attempt_count + random() * 0.05)
                   )::geography,
        updated_at = now()
    FROM missions m
    WHERE m.ambulance_id = a.id
      AND m.state = 'dispatched'
  `;

  // إكمال المهام التي انتهى وقتها المقدّر
  const completed = await sql`
    UPDATE missions
    SET state = 'completed', completed_at = now()
    WHERE state = 'dispatched'
      AND dispatched_at + (eta_seconds || ' seconds')::interval < now()
    RETURNING id, ambulance_id, facility_id, incident_id
  `;

  for (const m of completed as unknown as Array<{
    ambulance_id: string; facility_id: string; incident_id: string;
  }>) {
    // السيارة تعود للخدمة
    await sql`
      UPDATE ambulances SET state = 'available', updated_at = now()
      WHERE id = ${m.ambulance_id}::uuid
    `;
    // المريض يُسجَّل في المنشأة ⇒ الإشغال يزيد ⇒ حلقة [F] → [A]
    await sql`
      UPDATE facilities
      SET occupied_beds = LEAST(total_beds, occupied_beds + 1),
          updated_at = now()
      WHERE id = ${m.facility_id}::uuid
    `;
    await sql`
      UPDATE incidents SET state = 'resolved', resolved_at = now()
      WHERE id = ${m.incident_id}::uuid
    `;
  }

  return completed.length;
}

// ---------------------------------------------------------------------
// 3. تذبذب الإشغال الطبيعي (دخول/خروج مرضى)
// ---------------------------------------------------------------------
export async function fluctuateOccupancy() {
  await sql`
    UPDATE facilities
    SET occupied_beds = GREATEST(0, LEAST(
          total_beds,
          occupied_beds + (floor(random() * 7) - 3)::int
        )),
        updated_at = now()
    WHERE random() < 0.4
  `;
}

// ---------------------------------------------------------------------
// 4. إعادة تقييم الحالة اللونية — [A] ثم [B] لكل المنشآت
// ---------------------------------------------------------------------
export async function refreshFacilityStatuses() {
  const rows = await sql`
    UPDATE facilities
    SET status = CASE
          WHEN occupancy_ratio(total_beds, occupied_beds) > 90
            THEN 'RED'::facility_status
          ELSE 'GREEN'::facility_status
        END
    WHERE status IS DISTINCT FROM (
      CASE WHEN occupancy_ratio(total_beds, occupied_beds) > 90
           THEN 'RED'::facility_status ELSE 'GREEN'::facility_status END
    )
    RETURNING id, name, status
  `;
  return rows as unknown as Array<{ id: string; name: string; status: string }>;
}

// ---------------------------------------------------------------------
// 5. أرشفة مواقع السيارات (تغذّي الآلة الزمنية)
// ---------------------------------------------------------------------
export async function archiveAmbulances() {
  await sql`
    INSERT INTO ambulance_history (ambulance_id, recorded_at, location, state)
    SELECT id, now(), location, state FROM ambulances
  `;
}

// ---------------------------------------------------------------------
// النبضة الكاملة — تُستدعى من /api/tick كل بضع ثوانٍ
// ---------------------------------------------------------------------
export async function tick(seed = Date.now()) {
  const rng = makeRng(seed);
  const log: string[] = [];

  await fluctuateOccupancy();
  const changed = await refreshFacilityStatuses();
  if (changed.length) log.push(`تغيّرت حالة ${changed.length} منشأة`);

  const done = await advanceMissions();
  if (done) log.push(`اكتملت ${done} مهمة`);

  // بلاغ جديد باحتمال 60%
  let dispatch = null;
  if (rng() < 0.6) {
    const incident = await spawnIncident(rng);
    log.push(`بلاغ جديد: ${incident.description} (خطورة ${incident.severity})`);

    // تشغيل المخطط الانسيابي على البلاغ
    const outcome = await runDispatchFlow(incident, createDbDataSource());
    dispatch = outcome;
    log.push(`نتيجة التوجيه: ${outcome.status}`);
  }

  await archiveAmbulances();

  return { seed, log, dispatch, statusChanges: changed };
}
