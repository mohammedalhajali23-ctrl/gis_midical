'use client';

// components/Dashboard.tsx
//
// اللوحة الرئيسية. تسحب /api/state كل 4 ثوانٍ (Polling) — يُستبدل لاحقاً
// بدفع فوري عبر Cloudflare Durable Object دون تغيير الواجهة، لأن كل العرض
// مبني على كائن state واحد.

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-sm text-slate-500">
      جارٍ تحميل الخريطة…
    </div>
  ),
});

const POLL_MS = 4000;

export default function Dashboard() {
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [clustered, setClustered] = useState(false);
  const [busy, setBusy] = useState(false);

  const [trace, setTrace] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // وضع طلب الإسعاف بالنقر على الخريطة
  const [requestMode, setRequestMode] = useState(false);
  const [severity, setSeverity] = useState(3);

  // الفلاتر
  const [gov, setGov] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [ambState, setAmbState] = useState('');

  // الآلة الزمنية
  const [timeTravel, setTimeTravel] = useState('');
  const [snapshot, setSnapshot] = useState<any>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (gov) p.set('governorateId', gov);
    if (type) p.set('type', type);
    if (status) p.set('status', status);
    if (ambState) p.set('ambulanceState', ambState);
    if (clustered) p.set('clusters', '1');
    return p.toString();
  }, [gov, type, status, ambState, clustered]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/state?${query}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setState(j);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!live || snapshot) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [live, load, snapshot]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  }

  /** نقرة على الخريطة في وضع الطلب → إنشاء بلاغ + تشغيل المخطط */
  async function requestAt(lat: number, lon: number) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat,
          lon,
          severity,
          description: `طلب إسعاف — خطورة ${severity}`,
          autoDispatch: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);

      setTrace(j.outcome?.trace ?? []);
      setOutcome(j.outcome?.status ?? null);

      if (j.outcome?.status === 'DISPATCHED') {
        flash(
          `${j.outcome.ambulanceCode} ← ${j.outcome.facilityName} · ` +
            `${(j.outcome.distanceMeters / 1000).toFixed(1)} كم · ` +
            `وصول خلال ${Math.round(j.outcome.etaSeconds / 60)} د`
        );
      } else {
        flash(`تعذّر التوجيه: ${j.outcome?.reason ?? 'سبب غير معروف'}`);
      }
      await load();
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** إجراء على مهمة: وصول / تسليم / إلغاء */
  async function missionAction(
    missionId: string,
    action: 'arrive' | 'complete' | 'cancel'
  ) {
    setBusy(true);
    try {
      const r = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId, action }),
      });
      const j = await r.json();
      flash(j.ok ? j.message : `خطأ: ${j.error}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runTick() {
    setBusy(true);
    try {
      const r = await fetch('/api/tick', { method: 'POST' });
      const j = await r.json();
      if (j.dispatch?.trace) {
        setTrace(j.dispatch.trace);
        setOutcome(j.dispatch.status);
      }
      if (j.log?.length) flash(j.log.join(' · '));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function loadSnapshot(at: string) {
    if (!at) return setSnapshot(null);
    const r = await fetch(`/api/history?at=${encodeURIComponent(at)}`);
    const j = await r.json();
    if (j.ok) setSnapshot(j);
  }

  const s = state?.summary;
  const viewFacilities = snapshot ? snapshot.facilities : state?.facilities ?? [];
  const viewAmbulances = snapshot ? snapshot.ambulances : state?.ambulances ?? [];
  const missions = state?.missions ?? [];

  return (
    <div dir="rtl" className="flex h-screen flex-col bg-[#0B0F14] text-slate-200">
      {/* ───────── الشريط العلوي ───────── */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-5 py-3">
        <h1 className="text-lg font-semibold tracking-tight">
          مركز المراقبة والاستجابة الطبية
        </h1>

        {s && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs">
            <Metric label="المنشآت" value={s.facilities} />
            <Metric label="حرجة" value={s.red} tone="red" />
            <Metric label="إسعاف متاح" value={s.ambulancesAvailable} tone="blue" />
            <Metric label="مشغولة" value={s.ambulancesBusy} tone="pink" />
            <Metric label="بلاغات" value={s.activeIncidents} tone="amber" />
            <Metric
              label="الأسرّة"
              value={`${s.totalBeds - s.occupiedBeds}/${s.totalBeds}`}
            />
            <Metric label="الإشغال" value={`${s.occupancyPct}%`} />
          </div>
        )}

        <div className="mr-auto flex items-center gap-2">
          <button
            onClick={() => setLive((v) => !v)}
            className={`rounded border px-3 py-1 text-xs transition ${
              live
                ? 'border-emerald-600/50 bg-emerald-600/10 text-emerald-400'
                : 'border-slate-700 text-slate-400'
            }`}
          >
            <span className={live ? 'animate-pulse' : ''}>●</span> بث حي
          </button>
          <button
            onClick={runTick}
            disabled={busy}
            className="rounded border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
          >
            نبضة محاكاة
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-red-900 bg-red-950/50 px-5 py-2 text-xs text-red-300">
          تعذّر جلب الحالة: {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ───────── الخريطة ───────── */}
        <main className="relative min-w-0 flex-1">
          {state && (
            <MapView
              facilities={viewFacilities}
              ambulances={viewAmbulances}
              incidents={snapshot ? [] : state.incidents}
              missions={snapshot ? [] : missions}
              governorates={state.governorates}
              clusters={clustered ? state.clusters : null}
              requestMode={requestMode && !snapshot}
              onRequestAt={requestAt}
              fitKey={query + (snapshot ? 'snap' : '')}
            />
          )}

          {/* شريط وضع الطلب */}
          {requestMode && !snapshot && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] bg-sky-500/90 py-1.5 text-center text-xs font-medium text-sky-950">
              {busy
                ? 'جارٍ تنفيذ المخطط…'
                : 'انقر على الخريطة لتحديد موقع الحالة — سيبحث النظام عن أقرب إسعاف ومنشأة مؤهلة'}
            </div>
          )}

          {snapshot && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] bg-amber-500/90 py-1 text-center text-xs font-medium text-amber-950">
              عرض أرشيفي — {new Date(snapshot.timestamp).toLocaleString('ar')}
            </div>
          )}

          {toast && (
            <div className="absolute bottom-4 left-4 z-[1000] max-w-md rounded border border-slate-700 bg-[#111A22]/95 px-4 py-2.5 text-xs leading-relaxed shadow-lg backdrop-blur">
              {toast}
            </div>
          )}

          <div className="absolute bottom-4 right-4 z-[1000] rounded border border-slate-800 bg-[#0B0F14]/90 p-3 text-[11px] backdrop-blur">
            <Legend color="#10B981" label="ضمن السعة" />
            <Legend color="#EF4444" label="تجاوزت 90%" />
            <Legend color="#38BDF8" label="إسعاف متاح" />
            <Legend color="#F472B6" label="إسعاف مشغول" />
            <Legend color="#F59E0B" label="بلاغ نشط" />
          </div>
        </main>

        {/* ───────── الشريط الجانبي ───────── */}
        <aside className="flex w-80 flex-col gap-4 overflow-y-auto border-r border-slate-800 p-4">
          {/* طلب إسعاف */}
          <Section title="طلب إسعاف">
            <button
              onClick={() => setRequestMode((v) => !v)}
              disabled={!!snapshot}
              className={`w-full rounded border px-3 py-2 text-xs font-medium transition disabled:opacity-40 ${
                requestMode
                  ? 'border-sky-500 bg-sky-500/20 text-sky-200'
                  : 'border-sky-700/60 bg-sky-600/10 text-sky-300 hover:bg-sky-600/20'
              }`}
            >
              {requestMode ? 'إلغاء وضع الطلب' : 'طلب إسعاف بالنقر على الخريطة'}
            </button>

            <label className="block">
              <span className="mb-1 block text-[10px] text-slate-500">
                درجة الخطورة
              </span>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setSeverity(n)}
                    className={`flex-1 rounded border py-1 text-xs transition ${
                      severity === n
                        ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                        : 'border-slate-700 text-slate-500 hover:bg-slate-800'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </label>
          </Section>

          {/* المهام الجارية */}
          <Section title="المهام الجارية" hint={`${missions.length}`}>
            {missions.length === 0 ? (
              <p className="text-xs text-slate-500">لا مهام جارية.</p>
            ) : (
              <ul className="space-y-2">
                {missions.map((m: any) => (
                  <li
                    key={m.id}
                    className="rounded border border-slate-800 bg-slate-900/60 p-2 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <b className="text-sky-300">{m.ambulance_code}</b>
                      <span className="text-slate-500">
                        {(Number(m.distance_meters) / 1000).toFixed(1)} كم ·{' '}
                        {Math.round(Number(m.eta_seconds) / 60)} د
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-slate-400">
                      ← {m.facility_name}
                    </div>
                    {m.is_manual_override && (
                      <div className="mt-1 text-[10px] text-amber-400">
                        تجاوز يدوي
                      </div>
                    )}
                    <div className="mt-2 flex gap-1.5">
                      {m.state === 'dispatched' && (
                        <button
                          onClick={() => missionAction(m.id, 'arrive')}
                          disabled={busy}
                          className="flex-1 rounded border border-slate-700 py-1 text-[10px] hover:bg-slate-800 disabled:opacity-40"
                        >
                          وصلت الموقع
                        </button>
                      )}
                      <button
                        onClick={() => missionAction(m.id, 'complete')}
                        disabled={busy}
                        className="flex-1 rounded border border-emerald-700/60 bg-emerald-600/10 py-1 text-[10px] text-emerald-300 hover:bg-emerald-600/20 disabled:opacity-40"
                      >
                        تسليم المريض
                      </button>
                      <button
                        onClick={() => missionAction(m.id, 'cancel')}
                        disabled={busy}
                        className="rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                      >
                        إلغاء
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* مسار تنفيذ المخطط */}
          <Section title="مسار التنفيذ في المخطط" hint={outcome ?? undefined}>
            {trace.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-500">
                اطلب إسعافاً من الخريطة، أو اضغط «نبضة محاكاة». سيظهر هنا مسار
                تنفيذ المخطط الانسيابي عقدةً بعقدة.
              </p>
            ) : (
              <ol className="space-y-1.5 font-mono text-[11px] leading-relaxed">
                {trace.map((line, i) => (
                  <li
                    key={i}
                    className={`border-r-2 pr-2 ${
                      line.startsWith('[C]')
                        ? 'border-red-500 text-red-300'
                        : line.startsWith('[D]') || line.startsWith('[F]')
                          ? 'border-emerald-500 text-emerald-300'
                          : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    {line}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {/* الفلاتر */}
          <Section title="الفلترة">
            <Select value={gov} onChange={setGov} label="المحافظة">
              <option value="">كل المحافظات</option>
              {state?.governorates?.map((g: any) => (
                <option key={g.id} value={g.id}>
                  {g.name_ar}
                </option>
              ))}
            </Select>

            <Select value={type} onChange={setType} label="نوع المنشأة">
              <option value="">كل الأنواع</option>
              <option value="central_hospital">مشفى مركزي</option>
              <option value="clinic">مستوصف</option>
              <option value="field_point">نقطة ميدانية</option>
            </Select>

            <Select value={status} onChange={setStatus} label="الحالة">
              <option value="">الكل</option>
              <option value="RED">حرجة</option>
              <option value="GREEN">ضمن السعة</option>
            </Select>

            <Select value={ambState} onChange={setAmbState} label="سيارات الإسعاف">
              <option value="">الكل</option>
              <option value="available">متاحة</option>
              <option value="en_route">في الطريق</option>
              <option value="transporting">تنقل حالة</option>
              <option value="offline">خارج الخدمة</option>
            </Select>

            <label className="mt-1 flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={clustered}
                onChange={(e) => setClustered(e.target.checked)}
                className="accent-sky-500"
              />
              تجميع النقاط (ST_ClusterDBSCAN)
            </label>
          </Section>

          {/* الآلة الزمنية */}
          <Section title="العودة بالزمن">
            <input
              type="datetime-local"
              value={timeTravel}
              onChange={(e) => setTimeTravel(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => loadSnapshot(new Date(timeTravel).toISOString())}
                disabled={!timeTravel}
                className="flex-1 rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
              >
                اعرض تلك اللحظة
              </button>
              <button
                onClick={() => {
                  setSnapshot(null);
                  setTimeTravel('');
                }}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800"
              >
                عودة للحاضر
              </button>
            </div>
          </Section>

          {/* التنبيهات */}
          <Section title="التنبيهات">
            {!state?.alerts?.length ? (
              <p className="text-xs text-slate-500">لا تنبيهات.</p>
            ) : (
              <ul className="space-y-2">
                {state.alerts.slice(0, 8).map((a: any) => (
                  <li
                    key={a.id}
                    className={`rounded border-r-2 bg-slate-900/60 p-2 text-[11px] leading-relaxed ${
                      a.level === 'OVERRIDE'
                        ? 'border-amber-500 text-amber-200'
                        : 'border-red-500 text-slate-300'
                    }`}
                  >
                    {a.message}
                    <div className="mt-1 text-[10px] text-slate-500">
                      {new Date(a.created_at).toLocaleTimeString('ar')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </div>
  );
}

/* ───────── عناصر مساعدة ───────── */

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'red' | 'green' | 'blue' | 'amber' | 'pink';
}) {
  const c =
    tone === 'red' ? 'text-red-400'
    : tone === 'green' ? 'text-emerald-400'
    : tone === 'blue' ? 'text-sky-400'
    : tone === 'amber' ? 'text-amber-400'
    : tone === 'pink' ? 'text-pink-400'
    : 'text-slate-200';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-slate-500">{label}</span>
      <b className={`text-sm ${c}`}>{value}</b>
    </span>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-widest text-slate-500">
        {title}
        {hint && (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-slate-400">
            {hint}
          </span>
        )}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Select({
  value,
  onChange,
  label,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs"
      >
        {children}
      </select>
    </label>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ background: color }}
      />
      <span className="text-slate-400">{label}</span>
    </div>
  );
}
