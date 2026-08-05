// lib/dispatch/engine.test.ts
// تشغيل:  node --test --experimental-strip-types lib/dispatch/engine.test.ts
//
// اختبارات الحالات الحدّية التي لا يغطّيها المخطط الانسيابي.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAvailableBeds,
  calculateOccupancyPct,
  isOverCapacity,
  evaluateFacilityStatus,
  runDispatchFlow,
  MAX_ATTEMPTS,
} from './engine.ts';
import type { DispatchDataSource, Incident } from '../../types/index.ts';

const incident: Incident = {
  id: 'inc-1',
  lat: 33.51,
  lon: 36.29,
  severity: 4,
  description: 'اختبار',
};

/** مصدر بيانات وهمي قابل للتشكيل */
function makeDb(opts: {
  ambulance?: { id: string; code: string; distanceMeters: number } | null;
  facilities: Array<{
    id: string;
    name: string;
    totalBeds: number;
    occupiedBeds: number;
    distanceMeters: number;
  }>;
}): DispatchDataSource & { dispatched: unknown[]; alerts: string[] } {
  const dispatched: unknown[] = [];
  const alerts: string[] = [];
  return {
    dispatched,
    alerts,
    async findNearestAmbulance() {
      return opts.ambulance === undefined
        ? { id: 'amb-1', code: 'AMB-1-1', distanceMeters: 3574 }
        : opts.ambulance;
    },
    async findCandidateFacility(_loc, excluded) {
      return opts.facilities.find((f) => !excluded.includes(f.id)) ?? null;
    },
    async setFacilityStatus() {},
    async triggerAlert(_id, msg) {
      alerts.push(msg);
    },
    async assignRouteAndDispatch(input) {
      dispatched.push(input);
    },
  };
}

// ---------------------------------------------------------------------
// الدوال الحسابية
// ---------------------------------------------------------------------

test('[A] حساب الأسرّة المتاحة', () => {
  assert.equal(calculateAvailableBeds(420, 361), 59);
  assert.equal(calculateAvailableBeds(100, 100), 0);
});

test('نسبة الإشغال تُحسب بشكل صحيح', () => {
  assert.equal(calculateOccupancyPct(200, 100), 50);
  assert.equal(calculateOccupancyPct(100, 95), 95);
});

test('حماية القسمة على صفر — طاقة 0 تعني 100% إشغال', () => {
  assert.equal(calculateOccupancyPct(0, 0), 100);
  assert.equal(evaluateFacilityStatus(0, 0).status, 'RED');
});

test('[B] الحد 90% حرفياً: > وليس ≥', () => {
  assert.equal(isOverCapacity(90), false); // 90.0 بالضبط = أخضر
  assert.equal(isOverCapacity(90.01), true);
  assert.equal(isOverCapacity(89.99), false);
});

test('التصنيف اللوني ثنائي كما في المخطط', () => {
  assert.equal(evaluateFacilityStatus(100, 50).status, 'GREEN');
  assert.equal(evaluateFacilityStatus(100, 91).status, 'RED');
});

// ---------------------------------------------------------------------
// المسار الكامل
// ---------------------------------------------------------------------

test('المسار الناجح: NO → GREEN → Dispatch', async () => {
  const db = makeDb({
    facilities: [
      { id: 'f1', name: 'المواساة', totalBeds: 420, occupiedBeds: 361, distanceMeters: 1200 },
    ],
  });
  const r = await runDispatchFlow(incident, db);

  assert.equal(r.status, 'DISPATCHED');
  if (r.status !== 'DISPATCHED') return;
  assert.equal(r.facilityName, 'المواساة');
  assert.equal(r.attempts, 1);
  assert.equal(r.rejectedFacilities.length, 0);
  assert.equal(db.dispatched.length, 1);
});

test('حلقة RED: يستبعد الممتلئ وينتقل للتالي', async () => {
  const db = makeDb({
    facilities: [
      { id: 'f1', name: 'ابن النفيس', totalBeds: 260, occupiedBeds: 250, distanceMeters: 900 },  // 96%
      { id: 'f2', name: 'الأسد الجامعي', totalBeds: 380, occupiedBeds: 220, distanceMeters: 2100 }, // 58%
    ],
  });
  const r = await runDispatchFlow(incident, db);

  assert.equal(r.status, 'DISPATCHED');
  if (r.status !== 'DISPATCHED') return;
  assert.equal(r.facilityName, 'الأسد الجامعي');
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.rejectedFacilities, ['f1']);
  assert.equal(db.alerts.length, 1); // تنبيه واحد للمنشأة الحمراء
});

test('لا توجد سيارة إسعاف → مخرج صريح بدل التعطّل', async () => {
  const db = makeDb({ ambulance: null, facilities: [] });
  const r = await runDispatchFlow(incident, db);
  assert.equal(r.status, 'NO_AMBULANCE_AVAILABLE');
});

test('كل المنشآت حمراء → لا حلقة لا نهائية', async () => {
  const many = Array.from({ length: MAX_ATTEMPTS + 3 }, (_, i) => ({
    id: `f${i}`,
    name: `منشأة ${i}`,
    totalBeds: 100,
    occupiedBeds: 99,
    distanceMeters: 1000 + i,
  }));
  const db = makeDb({ facilities: many });
  const r = await runDispatchFlow(incident, db);

  assert.equal(r.status, 'NO_CAPACITY_AVAILABLE');
  assert.equal(r.attempts, MAX_ATTEMPTS);
  assert.equal(db.dispatched.length, 0);
});

test('نفاد المرشّحين قبل بلوغ السقف', async () => {
  const db = makeDb({
    facilities: [
      { id: 'f1', name: 'وحيدة', totalBeds: 50, occupiedBeds: 50, distanceMeters: 500 },
    ],
  });
  const r = await runDispatchFlow(incident, db);
  assert.equal(r.status, 'NO_CAPACITY_AVAILABLE');
  assert.deepEqual(r.rejectedFacilities, ['f1']);
});
