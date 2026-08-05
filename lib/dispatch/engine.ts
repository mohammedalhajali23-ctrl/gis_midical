// lib/dispatch/engine.ts
//
// ترجمة حرفية للمخطط الانسيابي المرفق مع وثيقة المتطلبات.
// كل عقدة في المخطط لها تعليق يشير إليها، وكل انحراف عن المخطط
// موثّق صراحةً تحت وسم [DEVIATION] مع سببه.
//
// ---------------------------------------------------------------------
// عقد المخطط:
//   [A] Calculate: Available Beds = Total - Occupied
//   [B] Occupancy > 90% ?            (قرار)
//   [C] Set Status: RED & Trigger Alert     (فرع YES)
//   [D] Set Status: GREEN                   (فرع NO)
//   [E] Find Nearest Ambulance (PostGIS ST_Distance)
//   [F] Assign Route & Dispatch
//
// المسارات المعتمدة (بعد استبعاد الخطوط المشطوبة في الرسم):
//   [E] ──▶ [B]        السيارة المُوجدة تدخل بوابة التقييم
//   [A] ──▶ [B]        حساب الأسرّة يغذّي القرار
//   [B] ──YES──▶ [C] ──▶ [E]   حلقة إعادة المحاولة بمرشّح آخر
//   [B] ──NO───▶ [D] ──▶ [F]   المسار الناجح
//   [F] ──▶ [A]        تحديث الحالة بعد الإرسال
// ---------------------------------------------------------------------

import type {
  DispatchDataSource,
  DispatchOutcome,
  Incident,
  LatLng,
} from '@/types';

/** عتبة الإشغال — 90% حرفياً كما في المخطط */
export const OCCUPANCY_THRESHOLD = 90;

/**
 * [DEVIATION #1] المخطط لا يحتوي شرط خروج من حلقة RED.
 * تنفيذه حرفياً يُنتج حلقة لا نهائية إذا كانت كل المنشآت فوق العتبة.
 * أضفنا سقفاً للمحاولات ينتهي بحالة NO_CAPACITY_AVAILABLE.
 */
export const MAX_ATTEMPTS = 5;

/** نصف قطر البحث عن سيارة الإسعاف بالأمتار */
export const SEARCH_RADIUS_METERS = 50_000;

/** متوسط سرعة سيارة الإسعاف (م/ث) ≈ 50 كم/س — لحساب الـETA */
const AVG_SPEED_MPS = 13.9;

/**
 * [A] حساب الأسرّة المتاحة — الصندوق الأول في المخطط.
 */
export function calculateAvailableBeds(
  totalBeds: number,
  occupiedBeds: number
): number {
  return totalBeds - occupiedBeds;
}

/**
 * حساب نسبة الإشغال.
 *
 * [DEVIATION #2] المخطط لا يعرّف نسبة الإشغال ولا يعالج حالة
 * الطاقة الاستيعابية = 0 (قسمة على صفر). اعتمدنا: منشأة بلا أسرّة
 * تُعتبر مشغولة 100% أي غير قادرة على الاستقبال — وهو التفسير
 * الآمن طبياً.
 */
export function calculateOccupancyPct(
  totalBeds: number,
  occupiedBeds: number
): number {
  if (totalBeds <= 0) return 100;
  return (occupiedBeds / totalBeds) * 100;
}

/**
 * [B] بوابة القرار: هل نسبة الإشغال > 90% ؟
 *
 * ملاحظة: المخطط يستخدم "<" حرفياً وليس "≥"، لذا الإشغال 90.0%
 * بالضبط يقع في فرع NO (أخضر). محفوظ كما هو عمداً.
 */
export function isOverCapacity(occupancyPct: number): boolean {
  return occupancyPct > OCCUPANCY_THRESHOLD;
}

/**
 * تنفيذ المخطط الانسيابي كاملاً لبلاغ واحد.
 */
export async function runDispatchFlow(
  incident: Incident,
  db: DispatchDataSource
): Promise<DispatchOutcome> {
  const trace: string[] = [];
  const rejectedFacilities: string[] = [];
  const location: LatLng = { lat: incident.lat, lon: incident.lon };

  // -----------------------------------------------------------------
  // [E] البحث عن أقرب سيارة إسعاف عبر PostGIS
  // -----------------------------------------------------------------
  trace.push('[E] البحث عن أقرب سيارة إسعاف متاحة');
  const ambulance = await db.findNearestAmbulance(
    location,
    SEARCH_RADIUS_METERS
  );

  /**
   * [DEVIATION #3] المخطط يفترض ضمنياً وجود سيارة دائماً.
   * أضفنا مخرجاً صريحاً عند عدم توفر أي سيارة ضمن نطاق البحث.
   */
  if (!ambulance) {
    trace.push('[E] ✗ لا توجد سيارة إسعاف متاحة ضمن النطاق');
    return {
      status: 'NO_AMBULANCE_AVAILABLE',
      reason: `لا توجد سيارة متاحة ضمن ${SEARCH_RADIUS_METERS / 1000} كم`,
      rejectedFacilities,
      attempts: 0,
      trace,
    };
  }
  trace.push(
    `[E] ✓ ${ambulance.code} على بُعد ${Math.round(ambulance.distanceMeters)} م`
  );

  // -----------------------------------------------------------------
  // حلقة إعادة المحاولة: [B] → [C] → [E] → [B] ...
  // -----------------------------------------------------------------
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const facility = await db.findCandidateFacility(
      location,
      rejectedFacilities
    );

    if (!facility) {
      trace.push(`[B] ✗ نفدت المنشآت المرشّحة عند المحاولة ${attempt}`);
      return {
        status: 'NO_CAPACITY_AVAILABLE',
        reason: 'لا توجد منشأة مرشّحة متبقّية',
        rejectedFacilities,
        attempts: attempt - 1,
        trace,
      };
    }

    // [A] حساب الأسرّة المتاحة
    const availableBeds = calculateAvailableBeds(
      facility.totalBeds,
      facility.occupiedBeds
    );
    const occupancyPct = calculateOccupancyPct(
      facility.totalBeds,
      facility.occupiedBeds
    );
    trace.push(
      `[A] ${facility.name}: متاح ${availableBeds} سرير — إشغال ${occupancyPct.toFixed(1)}%`
    );

    // [B] القرار
    if (isOverCapacity(occupancyPct)) {
      // ---------------- فرع YES ----------------
      // [C] Set Status: RED & Trigger Alert
      trace.push(`[C] YES → ${facility.name} = RED + تنبيه`);
      await db.setFacilityStatus(facility.id, 'RED');
      await db.triggerAlert(
        facility.id,
        `${facility.name} تجاوزت عتبة الإشغال (${occupancyPct.toFixed(1)}%) — تم استبعادها من التوجيه`
      );
      rejectedFacilities.push(facility.id);
      // العودة إلى [E]/[B] بمرشّح آخر
      continue;
    }

    // ---------------- فرع NO ----------------
    // [D] Set Status: GREEN
    trace.push(`[D] NO → ${facility.name} = GREEN`);
    await db.setFacilityStatus(facility.id, 'GREEN');

    // [F] Assign Route & Dispatch
    const totalDistance = ambulance.distanceMeters + facility.distanceMeters;
    const etaSeconds = Math.round(totalDistance / AVG_SPEED_MPS);

    trace.push(
      `[F] إرسال ${ambulance.code} → ${facility.name} (ETA ${Math.round(etaSeconds / 60)} د)`
    );
    await db.assignRouteAndDispatch({
      incidentId: incident.id,
      ambulanceId: ambulance.id,
      facilityId: facility.id,
      distanceMeters: totalDistance,
      etaSeconds,
      rejectedFacilities,
      attempts: attempt,
    });

    return {
      status: 'DISPATCHED',
      ambulanceId: ambulance.id,
      ambulanceCode: ambulance.code,
      facilityId: facility.id,
      facilityName: facility.name,
      distanceMeters: totalDistance,
      etaSeconds,
      rejectedFacilities,
      attempts: attempt,
      trace,
    };
  }

  // خرجنا من الحلقة دون نجاح — كل المرشّحين تجاوزوا العتبة
  trace.push(`[B] ✗ استُنفدت ${MAX_ATTEMPTS} محاولات — كل المنشآت RED`);
  return {
    status: 'NO_CAPACITY_AVAILABLE',
    reason: `كل المنشآت ضمن النطاق تجاوزت ${OCCUPANCY_THRESHOLD}% إشغال`,
    rejectedFacilities,
    attempts: MAX_ATTEMPTS,
    trace,
  };
}

/**
 * إعادة تقييم حالة منشأة واحدة — تُستدعى دورياً من المحاكاة
 * ومن حلقة [F] → [A] بعد كل إرسال.
 */
export function evaluateFacilityStatus(
  totalBeds: number,
  occupiedBeds: number
): { availableBeds: number; occupancyPct: number; status: 'GREEN' | 'RED' } {
  const availableBeds = calculateAvailableBeds(totalBeds, occupiedBeds);
  const occupancyPct = calculateOccupancyPct(totalBeds, occupiedBeds);
  return {
    availableBeds,
    occupancyPct,
    status: isOverCapacity(occupancyPct) ? 'RED' : 'GREEN',
  };
}
