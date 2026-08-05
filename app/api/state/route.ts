// app/api/state/route.ts
//
// الحالة الكاملة للوحة في طلب واحد — تغذّي الخريطة والشريط الجانبي.
// تدعم الفلترة المطلوبة في الوثيقة: حسب المحافظة، نوع المنشأة،
// الحالة اللونية، وحالة سيارة الإسعاف.

import {
  getFacilities,
  getAmbulances,
  getGovernorates,
  getActiveIncidents,
  getActiveMissions,
  getAlerts,
  getClusters,
} from '@/lib/db/queries';
import type { FacilityStatus } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const govParam = searchParams.get('governorateId');
    const governorateId = govParam ? Number(govParam) : undefined;
    const type = searchParams.get('type') ?? undefined;
    const status = (searchParams.get('status') ?? undefined) as
      | FacilityStatus
      | undefined;
    const ambulanceState = searchParams.get('ambulanceState') ?? undefined;
    const withClusters = searchParams.get('clusters') === '1';

    // تنفيذ متوازٍ — الاستعلامات مستقلة عن بعضها
    const [facilities, ambulances, governorates, incidents, missions, alerts] =
      await Promise.all([
        getFacilities({ governorateId, type, status }),
        getAmbulances({ governorateId, state: ambulanceState }),
        getGovernorates(),
        getActiveIncidents(),
        getActiveMissions(),
        getAlerts(20),
      ]);

    const clusters = withClusters ? await getClusters() : null;

    // مؤشرات مجمّعة للشريط العلوي
    const totalBeds = facilities.reduce((s, f) => s + f.total_beds, 0);
    const occupiedBeds = facilities.reduce((s, f) => s + f.occupied_beds, 0);

    return Response.json({
      ok: true,
      timestamp: new Date().toISOString(),
      filters: { governorateId, type, status, ambulanceState },
      summary: {
        facilities: facilities.length,
        red: facilities.filter((f) => f.status === 'RED').length,
        green: facilities.filter((f) => f.status === 'GREEN').length,
        ambulancesAvailable: ambulances.filter((a) => a.state === 'available')
          .length,
        ambulancesBusy: ambulances.filter((a) => a.state !== 'available' && a.state !== 'offline')
          .length,
        activeIncidents: incidents.length,
        totalBeds,
        occupiedBeds,
        occupancyPct: totalBeds ? +((occupiedBeds / totalBeds) * 100).toFixed(1) : 0,
      },
      governorates,
      facilities,
      ambulances,
      incidents,
      missions,
      alerts,
      clusters,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
