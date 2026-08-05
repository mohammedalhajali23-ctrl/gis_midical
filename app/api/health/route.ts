// app/api/health/route.ts
//
// فحص سلامة السلسلة: المتصفح ← Next.js ← Neon ← PostGIS

import { sql } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const version = await sql`SELECT PostGIS_Version() AS version`;

    const tables = await sql`
      SELECT count(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;

    const counts = await sql`
      SELECT
        (SELECT count(*)::int FROM governorates) AS governorates,
        (SELECT count(*)::int FROM facilities)   AS facilities,
        (SELECT count(*)::int FROM ambulances)   AS ambulances,
        (SELECT count(*)::int FROM facilities WHERE status = 'RED') AS red_facilities,
        (SELECT count(*)::int FROM ambulances WHERE state = 'available') AS available_ambulances
    `;

    return Response.json({
      ok: true,
      postgis: version[0].version,
      tables: tables[0].n,
      data: counts[0],
    });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
