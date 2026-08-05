'use client';

// components/MapView.tsx
//
// طبقات الخريطة (من الأسفل إلى الأعلى):
//   1. خلفية داكنة (CARTO dark)
//   2. حدود المحافظات (GeoJSON من PostGIS)
//   3. مسارات المهام الجارية (LineString من ST_MakeLine)
//   4. المنشآت — أو عناقيدها عند تفعيل التجميع (ST_ClusterDBSCAN)
//   5. سيارات الإسعاف
//   6. البلاغات النشطة
//
// في وضع «طلب إسعاف» تلتقط الخريطة نقرة المستخدم وتُنشئ بلاغاً عندها.

import 'leaflet/dist/leaflet.css';
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  GeoJSON,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { Fragment, useEffect } from 'react';

const SYRIA_CENTER: [number, number] = [35.0, 38.0];

const COLORS = {
  green: '#10B981',
  red: '#EF4444',
  ambulance: '#38BDF8',
  ambulanceBusy: '#F472B6',
  ambulanceOffline: '#475569',
  incident: '#F59E0B',
  route: '#38BDF8',
  routeManual: '#F59E0B',
  boundary: '#334155',
};

const radiusOf = (type: string) =>
  type === 'central_hospital' ? 9 : type === 'clinic' ? 6 : 4;

const typeLabel = (t: string) =>
  t === 'central_hospital' ? 'مشفى مركزي'
  : t === 'clinic' ? 'مستوصف'
  : 'نقطة ميدانية';

const stateLabel = (s: string) =>
  s === 'available' ? 'متاحة'
  : s === 'en_route' ? 'في الطريق'
  : s === 'at_scene' ? 'في الموقع'
  : s === 'transporting' ? 'تنقل حالة'
  : 'خارج الخدمة';

const ambColor = (s: string) =>
  s === 'available' ? COLORS.ambulance
  : s === 'offline' ? COLORS.ambulanceOffline
  : COLORS.ambulanceBusy;

function Resizer({ trigger }: { trigger: string }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
  }, [trigger, map]);
  return null;
}

/** يلتقط نقرة المستخدم لإنشاء بلاغ عند تلك النقطة */
function ClickHandler({
  active,
  onPick,
}: {
  active: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  const map = useMap();
  useMapEvents({
    click(e) {
      if (active) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  useEffect(() => {
    map.getContainer().style.cursor = active ? 'crosshair' : '';
  }, [active, map]);
  return null;
}

type Props = {
  facilities: any[];
  ambulances: any[];
  incidents: any[];
  missions: any[];
  governorates: any[];
  clusters: any[] | null;
  requestMode: boolean;
  onRequestAt: (lat: number, lon: number) => void;
  fitKey: string;
};

export default function MapView({
  facilities,
  ambulances,
  incidents,
  missions,
  governorates,
  clusters,
  requestMode,
  onRequestAt,
  fitKey,
}: Props) {
  return (
    <MapContainer
      center={SYRIA_CENTER}
      zoom={7}
      className="h-full w-full"
      style={{ background: '#0B0F14' }}
      preferCanvas
    >
      <Resizer trigger={fitKey} />
      <ClickHandler active={requestMode} onPick={onRequestAt} />

      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution="&copy; OpenStreetMap &copy; CARTO"
      />

      {/* حدود المحافظات */}
      {governorates.map((g) => (
        <GeoJSON
          key={`gov-${g.id}`}
          data={g.geojson}
          style={{
            color: COLORS.boundary,
            weight: 1,
            fillOpacity: 0.04,
            fillColor: '#1E293B',
          }}
        />
      ))}

      {/* مسارات المهام: سيارة ← موقع البلاغ ← المنشأة */}
      {missions
        .filter((m) => m.route?.coordinates)
        .map((m) => {
          const pts = m.route.coordinates.map(
            (c: [number, number]) => [c[1], c[0]] as [number, number]
          );
          const manual = m.is_manual_override;
          const color = manual ? COLORS.routeManual : COLORS.route;
          return (
            <Fragment key={`route-${m.id}`}>
              {/* هالة سفلية لإبراز المسار فوق الخريطة الداكنة */}
              <Polyline
                positions={pts}
                pathOptions={{ color, weight: 7, opacity: 0.15 }}
              />
              <Polyline
                positions={pts}
                pathOptions={{
                  color,
                  weight: 2.5,
                  dashArray: '8 6',
                  opacity: 0.95,
                }}
              >
                <Tooltip sticky>
                  <div className="text-right">
                    <b>{m.ambulance_code}</b> ← {m.facility_name}
                    <br />
                    {(Number(m.distance_meters) / 1000).toFixed(1)} كم · وصول خلال{' '}
                    {Math.round(Number(m.eta_seconds) / 60)} د
                    {manual ? (
                      <>
                        <br />
                        تجاوز يدوي
                      </>
                    ) : null}
                  </div>
                </Tooltip>
              </Polyline>
            </Fragment>
          );
        })}

      {/* المنشآت — أو العناقيد */}
      {clusters
        ? clusters.map((c, i) => (
            <CircleMarker
              key={`cl-${i}`}
              center={[c.lat, c.lon]}
              radius={8 + Math.min(18, Number(c.point_count) * 2)}
              pathOptions={{
                color: Number(c.red_count) > 0 ? COLORS.red : COLORS.green,
                fillColor: Number(c.red_count) > 0 ? COLORS.red : COLORS.green,
                fillOpacity: 0.25,
                weight: 2,
              }}
            >
              <Tooltip>
                {c.point_count} منشأة — {c.red_count} حمراء
              </Tooltip>
            </CircleMarker>
          ))
        : facilities.map((f) => (
            <CircleMarker
              key={f.id}
              center={[f.lat, f.lon]}
              radius={radiusOf(f.type)}
              pathOptions={{
                color: f.status === 'RED' ? COLORS.red : COLORS.green,
                fillColor: f.status === 'RED' ? COLORS.red : COLORS.green,
                fillOpacity: 0.75,
                weight: f.status === 'RED' ? 3 : 1,
              }}
            >
              <Tooltip direction="top">
                <div className="text-right">
                  <b>{f.name}</b>
                  <br />
                  {typeLabel(f.type)}
                  {f.governorate_name ? ` — ${f.governorate_name}` : ''}
                  {f.total_beds ? (
                    <>
                      <br />
                      {f.occupied_beds}/{f.total_beds} سرير (
                      {((f.occupied_beds / (f.total_beds || 1)) * 100).toFixed(0)}%)
                      <br />
                      متاح: {f.total_beds - f.occupied_beds} سرير
                    </>
                  ) : null}
                </div>
              </Tooltip>
            </CircleMarker>
          ))}

      {/* سيارات الإسعاف */}
      {ambulances.map((a) => (
        <CircleMarker
          key={a.id}
          center={[a.lat, a.lon]}
          radius={a.state === 'available' ? 4 : 5}
          pathOptions={{
            color: ambColor(a.state),
            fillColor: ambColor(a.state),
            fillOpacity: 0.9,
            weight: a.state === 'available' ? 1 : 2,
          }}
        >
          <Tooltip direction="top">
            <div className="text-right">
              <b>{a.code}</b>
              <br />
              {stateLabel(a.state)}
            </div>
          </Tooltip>
        </CircleMarker>
      ))}

      {/* البلاغات النشطة */}
      {incidents.map((i) => (
        <CircleMarker
          key={i.id}
          center={[i.lat, i.lon]}
          radius={5 + i.severity * 1.5}
          pathOptions={{
            color: COLORS.incident,
            fillColor: COLORS.incident,
            fillOpacity: i.state === 'pending' ? 0.7 : 0.2,
            weight: i.state === 'pending' ? 2 : 1,
          }}
        >
          <Tooltip direction="top">
            <div className="text-right">
              <b>{i.description}</b>
              <br />
              خطورة {i.severity} —{' '}
              {i.state === 'pending' ? 'بانتظار توجيه' : 'موجّه'}
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
