// lib/db/queries.ts
//
// كل استعلامات PostGIS في مكان واحد. المحرك في lib/dispatch/engine.ts
// لا يعرف شيئاً عن قاعدة البيانات — يستهلك الواجهة المصدَّرة من هنا فقط.

import { sql } from './client';
import type {
  Ambulance,
  DispatchDataSource,
  Facility,
  FacilityStatus,
  LatLng,
} from '@/types';

/** تحويل نقطة إلى تعبير geography — يُستخدم في كل الاستعلامات المكانية */
const pointOf = (loc: LatLng) => ({ lon: loc.lon, lat: loc.lat });

// =====================================================================
// استعلامات العرض (تغذّي الخريطة واللوحة)
// =====================================================================

export async function getFacilities(filters?: {
  governorateId?: number;
  type?: string;
  status?: FacilityStatus;
}): Promise<Facility[]> {
  const rows = await sql`
    SELECT
      f.id, f.name, f.type, f.governorate_id,
      ST_Y(f.location::geometry) AS lat,
      ST_X(f.location::geometry) AS lon,
      f.total_beds, f.occupied_beds, f.available_beds, f.status,
      g.name_ar AS governorate_name
    FROM facilities f
    JOIN governorates g ON g.id = f.governorate_id
    WHERE (${filters?.governorateId ?? null}::int IS NULL
           OR f.governorate_id = ${filters?.governorateId ?? null})
      AND (${filters?.type ?? null}::text IS NULL
           OR f.type::text = ${filters?.type ?? null})
      AND (${filters?.status ?? null}::text IS NULL
           OR f.status::text = ${filters?.status ?? null})
    ORDER BY f.name
  `;
  return rows as unknown as Facility[];
}

export async function getAmbulances(filters?: {
  governorateId?: number;
  state?: string;
}): Promise<Ambulance[]> {
  const rows = await sql`
    SELECT
      a.id, a.code, a.governorate_id, a.state, a.heading,
      ST_Y(a.location::geometry) AS lat,
      ST_X(a.location::geometry) AS lon
    FROM ambulances a
    WHERE (${filters?.governorateId ?? null}::int IS NULL
           OR a.governorate_id = ${filters?.governorateId ?? null})
      AND (${filters?.state ?? null}::text IS NULL
           OR a.state::text = ${filters?.state ?? null})
    ORDER BY a.code
  `;
  return rows as unknown as Ambulance[];
}

/** حدود المحافظات كـ GeoJSON — تُرسم كطبقة على الخريطة */
export async function getGovernorates() {
  return await sql`
    SELECT id, name_ar, name_en,
           ST_AsGeoJSON(boundary)::json AS geojson,
           ST_Y(centroid::geometry) AS lat,
           ST_X(centroid::geometry) AS lon
    FROM governorates
    ORDER BY name_ar
  `;
}

/** تجميع النقاط — مطلب Clustering في الوثيقة */
export async function getClusters(eps = 0.15) {
  return await sql`
    SELECT cluster_id, point_count, red_count,
           ST_Y(center) AS lat, ST_X(center) AS lon
    FROM cluster_facilities(${eps})
  `;
}

/** البلاغات النشطة */
export async function getActiveIncidents() {
  return await sql`
    SELECT i.id, i.severity, i.description, i.state, i.created_at,
           ST_Y(i.location::geometry) AS lat,
           ST_X(i.location::geometry) AS lon,
           g.name_ar AS governorate_name
    FROM incidents i
    LEFT JOIN governorates g ON g.id = i.governorate_id
    WHERE i.state IN ('pending', 'assigned')
    ORDER BY i.severity DESC, i.created_at DESC
    LIMIT 100
  `;
}

/** المهام الجارية مع مساراتها — تُرسم كخطوط على الخريطة */
export async function getActiveMissions() {
  return await sql`
    SELECT m.id, m.state, m.eta_seconds, m.distance_meters,
           m.attempt_count, m.is_manual_override,
           a.code AS ambulance_code,
           f.name AS facility_name,
           ST_AsGeoJSON(m.route)::json AS route
    FROM missions m
    JOIN ambulances a ON a.id = m.ambulance_id
    JOIN facilities f ON f.id = m.facility_id
    WHERE m.state IN ('dispatched', 'arrived')
    ORDER BY m.dispatched_at DESC
  `;
}

export async function getAlerts(limit = 20) {
  return await sql`
    SELECT id, level, message, acknowledged, created_at
    FROM alerts
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

// =====================================================================
// الآلة الزمنية — العودة بالزمن
// =====================================================================

export async function getSnapshot(timestamp: string) {
  const facilities = await sql`
    SELECT f.id, f.name, f.type,
           ST_Y(f.location::geometry) AS lat,
           ST_X(f.location::geometry) AS lon,
           s.occupancy_pct, s.status
    FROM snapshot_at(${timestamp}::timestamptz) s
    JOIN facilities f ON f.id = s.facility_id
  `;

  // آخر موقع مسجّل لكل سيارة قبل اللحظة المطلوبة
  const ambulances = await sql`
    SELECT DISTINCT ON (ah.ambulance_id)
           ah.ambulance_id AS id, a.code, ah.state,
           ST_Y(ah.location::geometry) AS lat,
           ST_X(ah.location::geometry) AS lon
    FROM ambulance_history ah
    JOIN ambulances a ON a.id = ah.ambulance_id
    WHERE ah.recorded_at <= ${timestamp}::timestamptz
    ORDER BY ah.ambulance_id, ah.recorded_at DESC
  `;

  return { timestamp, facilities, ambulances };
}

// =====================================================================
// تنفيذ DispatchDataSource — الجسر بين المحرك وقاعدة البيانات
// =====================================================================

export function createDbDataSource(): DispatchDataSource {
  return {
    // [E] البحث عن أقرب سيارة إسعاف متاحة
    async findNearestAmbulance(location, radiusMeters = 50_000) {
      const p = pointOf(location);
      const rows = await sql`
        SELECT a.id, a.code,
               ST_Distance(
                 a.location,
                 ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography
               ) AS distance_meters
        FROM ambulances a
        WHERE a.state = 'available'
          AND ST_DWithin(
                a.location,
                ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography,
                ${radiusMeters}
              )
        ORDER BY a.location <-> ST_SetSRID(
                   ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const r = rows[0] as { id: string; code: string; distance_meters: string };
      return {
        id: r.id,
        code: r.code,
        distanceMeters: Number(r.distance_meters),
      };
    },

    // المرشّح التالي، مع استبعاد ما رُفض في حلقة RED
    async findCandidateFacility(location, excluded) {
      const p = pointOf(location);
      const rows = await sql`
        SELECT f.id, f.name, f.total_beds, f.occupied_beds,
               ST_Distance(
                 f.location,
                 ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography
               ) AS distance_meters
        FROM facilities f
        WHERE NOT (f.id = ANY(${excluded}::uuid[]))
        ORDER BY f.location <-> ST_SetSRID(
                   ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const r = rows[0] as {
        id: string; name: string;
        total_beds: number; occupied_beds: number;
        distance_meters: string;
      };
      return {
        id: r.id,
        name: r.name,
        totalBeds: r.total_beds,
        occupiedBeds: r.occupied_beds,
        distanceMeters: Number(r.distance_meters),
      };
    },

    // [C] / [D] تغيير الحالة اللونية — التريغر يؤرشفها تلقائياً
    async setFacilityStatus(facilityId, status) {
      await sql`
        UPDATE facilities
        SET status = ${status}::facility_status, updated_at = now()
        WHERE id = ${facilityId}::uuid
      `;
    },

    // [C] إطلاق التنبيه
    async triggerAlert(facilityId, message) {
      await sql`
        INSERT INTO alerts (facility_id, level, message)
        VALUES (${facilityId}::uuid, 'CRITICAL', ${message})
      `;
    },

    // [F] إنشاء المهمة ورسم المسار وحجز السيارة
    async assignRouteAndDispatch(input) {
      await sql`
        WITH pts AS (
          SELECT i.location::geometry AS incident_pt,
                 a.location::geometry AS ambulance_pt,
                 f.location::geometry AS facility_pt
          FROM incidents i, ambulances a, facilities f
          WHERE i.id = ${input.incidentId}::uuid
            AND a.id = ${input.ambulanceId}::uuid
            AND f.id = ${input.facilityId}::uuid
        )
        INSERT INTO missions (
          incident_id, ambulance_id, facility_id, route,
          distance_meters, eta_seconds, rejected_facilities, attempt_count
        )
        SELECT
          ${input.incidentId}::uuid,
          ${input.ambulanceId}::uuid,
          ${input.facilityId}::uuid,
          ST_MakeLine(ARRAY[ambulance_pt, incident_pt, facility_pt])::geography,
          ${input.distanceMeters},
          ${input.etaSeconds},
          ${input.rejectedFacilities}::uuid[],
          ${input.attempts}
        FROM pts
      `;

      await sql`
        UPDATE ambulances SET state = 'en_route', updated_at = now()
        WHERE id = ${input.ambulanceId}::uuid
      `;

      await sql`
        UPDATE incidents SET state = 'assigned'
        WHERE id = ${input.incidentId}::uuid
      `;
    },
  };
}
