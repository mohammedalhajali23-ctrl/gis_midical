-- =====================================================================
-- Step 02 : Seed Data — المحافظات السورية والموارد الطبية
-- ملاحظة: حدود المحافظات هنا مبسّطة (مضلعات تقريبية) لغرض العرض.
--         لاستبدالها بالحدود الحقيقية، انظر القسم في نهاية الملف.
-- =====================================================================

TRUNCATE missions, incidents, alerts, ambulances, facilities, governorates
    RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------
-- 1. المحافظات (14 محافظة)
-- ---------------------------------------------------------------------
INSERT INTO governorates (name_ar, name_en, boundary) VALUES
('دمشق', 'Damascus', ST_GeomFromText('MULTIPOLYGON(((36.20 33.44, 36.38 33.44, 36.38 33.58, 36.20 33.58, 36.20 33.44)))', 4326)),
('ريف دمشق', 'Rif Dimashq', ST_GeomFromText('MULTIPOLYGON(((35.90 33.05, 37.60 33.05, 37.60 34.20, 35.90 34.20, 35.90 33.05)))', 4326)),
('القنيطرة', 'Quneitra', ST_GeomFromText('MULTIPOLYGON(((35.68 32.90, 36.10 32.90, 36.10 33.40, 35.68 33.40, 35.68 32.90)))', 4326)),
('درعا', 'Daraa', ST_GeomFromText('MULTIPOLYGON(((35.85 32.30, 36.55 32.30, 36.55 32.95, 35.85 32.95, 35.85 32.30)))', 4326)),
('السويداء', 'As-Suwayda', ST_GeomFromText('MULTIPOLYGON(((36.30 32.30, 37.40 32.30, 37.40 33.10, 36.30 33.10, 36.30 32.30)))', 4326)),
('حمص', 'Homs', ST_GeomFromText('MULTIPOLYGON(((36.00 34.20, 39.20 34.20, 39.20 35.30, 36.00 35.30, 36.00 34.20)))', 4326)),
('حماة', 'Hama', ST_GeomFromText('MULTIPOLYGON(((36.15 34.85, 38.20 34.85, 38.20 35.60, 36.15 35.60, 36.15 34.85)))', 4326)),
('طرطوس', 'Tartus', ST_GeomFromText('MULTIPOLYGON(((35.65 34.55, 36.25 34.55, 36.25 35.15, 35.65 35.15, 35.65 34.55)))', 4326)),
('اللاذقية', 'Latakia', ST_GeomFromText('MULTIPOLYGON(((35.55 35.10, 36.25 35.10, 36.25 35.95, 35.55 35.95, 35.55 35.10)))', 4326)),
('إدلب', 'Idlib', ST_GeomFromText('MULTIPOLYGON(((36.10 35.35, 37.05 35.35, 37.05 36.35, 36.10 36.35, 36.10 35.35)))', 4326)),
('حلب', 'Aleppo', ST_GeomFromText('MULTIPOLYGON(((36.35 35.75, 38.65 35.75, 38.65 36.90, 36.35 36.90, 36.35 35.75)))', 4326)),
('الرقة', 'Raqqa', ST_GeomFromText('MULTIPOLYGON(((38.20 35.10, 40.10 35.10, 40.10 36.85, 38.20 36.85, 38.20 35.10)))', 4326)),
('دير الزور', 'Deir ez-Zor', ST_GeomFromText('MULTIPOLYGON(((39.30 34.40, 41.20 34.40, 41.20 35.90, 39.30 35.90, 39.30 34.40)))', 4326)),
('الحسكة', 'Al-Hasakah', ST_GeomFromText('MULTIPOLYGON(((39.90 36.05, 42.35 36.05, 42.35 37.32, 39.90 37.32, 39.90 36.05)))', 4326));

UPDATE governorates SET centroid = ST_Centroid(boundary)::geography;

-- ---------------------------------------------------------------------
-- 2. المنشآت الطبية
--    الإحداثيات تقريبية لمراكز المدن — كافية للعرض والتحليل المكاني
-- ---------------------------------------------------------------------
INSERT INTO facilities (name, type, governorate_id, location, total_beds, occupied_beds)
SELECT v.name, v.ftype::facility_type, g.id,
       ST_SetSRID(ST_MakePoint(v.lon, v.lat), 4326)::geography,
       v.total, v.occupied
FROM (VALUES
  -- دمشق
  ('مشفى المواساة الجامعي',        'central_hospital', 'Damascus',    36.2920, 33.5010, 420, 361),
  ('مشفى الأسد الجامعي',           'central_hospital', 'Damascus',    36.2755, 33.5145, 380, 220),
  ('مشفى ابن النفيس',              'central_hospital', 'Damascus',    36.3010, 33.4930, 260, 250),
  ('مستوصف الميدان',               'clinic',           'Damascus',    36.2980, 33.4850,  40,  12),
  ('نقطة طبية - باب توما',         'field_point',      'Damascus',    36.3155, 33.5115,  10,   3),
  -- ريف دمشق
  ('مشفى دوما المركزي',            'central_hospital', 'Rif Dimashq', 36.4020, 33.5720, 180,  95),
  ('مشفى الزبداني',                'clinic',           'Rif Dimashq', 36.1010, 33.7250,  70,  64),
  ('نقطة طبية - القطيفة',          'field_point',      'Rif Dimashq', 36.6010, 33.7380,  12,   4),
  -- حلب
  ('مشفى حلب الجامعي',             'central_hospital', 'Aleppo',      37.1420, 36.2010, 450, 300),
  ('مشفى الرازي',                  'central_hospital', 'Aleppo',      37.1580, 36.2185, 300, 285),
  ('مشفى الكندي',                  'central_hospital', 'Aleppo',      37.1810, 36.2450, 220, 110),
  ('مستوصف السفيرة',               'clinic',           'Aleppo',      37.3730, 36.0730,  50,  20),
  ('نقطة طبية - منبج',             'field_point',      'Aleppo',      37.9550, 36.5280,  15,   9),
  -- حمص
  ('مشفى الزهراوي',                'central_hospital', 'Homs',        36.7130, 34.7290, 280, 150),
  ('مشفى البر والخدمات',           'clinic',           'Homs',        36.7250, 34.7350,  90,  84),
  ('نقطة طبية - تدمر',             'field_point',      'Homs',        38.2840, 34.5600,  10,   2),
  -- حماة
  ('مشفى حماة الوطني',             'central_hospital', 'Hama',        36.7530, 35.1320, 240, 130),
  ('مستوصف سلمية',                 'clinic',           'Hama',        37.0530, 35.0110,  45,  41),
  -- اللاذقية
  ('مشفى تشرين الجامعي',           'central_hospital', 'Latakia',     35.7900, 35.5240, 320, 175),
  ('مشفى الأسد - اللاذقية',        'central_hospital', 'Latakia',     35.7820, 35.5310, 200, 190),
  ('نقطة طبية - جبلة',             'field_point',      'Latakia',     35.9250, 35.3600,  14,   5),
  -- طرطوس
  ('مشفى الباسل - طرطوس',          'central_hospital', 'Tartus',      35.8860, 34.8890, 210, 120),
  ('مستوصف بانياس',                'clinic',           'Tartus',      35.9490, 35.1820,  55,  25),
  -- إدلب
  ('مشفى إدلب المركزي',            'central_hospital', 'Idlib',       36.6330, 35.9310, 190, 178),
  ('نقطة طبية - معرة النعمان',     'field_point',      'Idlib',       36.6740, 35.6470,  12,  11),
  -- درعا
  ('مشفى درعا الوطني',             'central_hospital', 'Daraa',       36.1010, 32.6250, 160,  70),
  ('مستوصف إزرع',                  'clinic',           'Daraa',       36.2320, 32.8560,  40,  15),
  -- السويداء
  ('مشفى السويداء الوطني',         'central_hospital', 'As-Suwayda',  36.5690, 32.7090, 150,  60),
  -- القنيطرة
  ('نقطة طبية - القنيطرة',         'field_point',      'Quneitra',    35.8230, 33.1260,  10,   1),
  -- الرقة
  ('مشفى الرقة الوطني',            'central_hospital', 'Raqqa',       38.9950, 35.9520, 170, 155),
  ('نقطة طبية - الطبقة',           'field_point',      'Raqqa',       38.5480, 35.8370,  12,   6),
  -- دير الزور
  ('مشفى دير الزور المركزي',       'central_hospital', 'Deir ez-Zor', 40.1400, 35.3350, 165,  88),
  ('نقطة طبية - الميادين',         'field_point',      'Deir ez-Zor', 40.4470, 35.0210,  10,   0),
  -- الحسكة
  ('مشفى الحسكة الوطني',           'central_hospital', 'Al-Hasakah',  40.7480, 36.5030, 175,  90),
  ('مشفى القامشلي',                'central_hospital', 'Al-Hasakah',  41.2280, 37.0530, 140, 132)
) AS v(name, ftype, gov_en, lon, lat, total, occupied)
JOIN governorates g ON g.name_en = v.gov_en;

-- تحديث الحالة اللونية وفق المخطط: نسبة الإشغال > 90% ⇒ RED
UPDATE facilities
SET status = CASE
    WHEN occupancy_ratio(total_beds, occupied_beds) > 90 THEN 'RED'::facility_status
    ELSE 'GREEN'::facility_status
END;

-- ---------------------------------------------------------------------
-- 3. سيارات الإسعاف — 3 لكل محافظة، موزّعة عشوائياً ضمن حدودها
-- ---------------------------------------------------------------------
INSERT INTO ambulances (code, governorate_id, location, heading, state)
SELECT
    'AMB-' || g.id || '-' || s.n,
    g.id,
    ST_SetSRID(ST_MakePoint(
        ST_XMin(g.boundary) + random() * (ST_XMax(g.boundary) - ST_XMin(g.boundary)),
        ST_YMin(g.boundary) + random() * (ST_YMax(g.boundary) - ST_YMin(g.boundary))
    ), 4326)::geography,
    round((random() * 360)::numeric, 1),
    (ARRAY['available','available','available','en_route','offline'])[1 + floor(random() * 5)]::ambulance_state
FROM governorates g
CROSS JOIN generate_series(1, 3) AS s(n);

-- ---------------------------------------------------------------------
-- 4. تحقق سريع
-- ---------------------------------------------------------------------
SELECT 'governorates' AS t, count(*) FROM governorates
UNION ALL SELECT 'facilities', count(*) FROM facilities
UNION ALL SELECT 'ambulances', count(*) FROM ambulances
UNION ALL SELECT 'RED facilities', count(*) FROM facilities WHERE status = 'RED'
UNION ALL SELECT 'available ambulances', count(*) FROM ambulances WHERE state = 'available';

-- =====================================================================
-- استبدال الحدود التقريبية بالحدود الحقيقية (اختياري — يرفع علامة GIS)
-- =====================================================================
-- 1) نزّل ملف GeoJSON لحدود محافظات سوريا (ADM1) من geoBoundaries أو HDX
-- 2) حمّله إلى جدول مؤقت ثم:
--    UPDATE governorates g SET boundary = ST_Multi(t.geom)
--    FROM tmp_adm1 t WHERE t.shapeName = g.name_en;
-- 3) UPDATE governorates SET centroid = ST_Centroid(boundary)::geography;
-- ملاحظة للـREADME: المضلعات المبسّطة كافية لعمليات ST_Within/ST_Contains
--                   لكن الحدود الحقيقية تعطي نتائج فلترة أدق عند التخوم.
