-- =====================================================================
-- GIS Medical Response Tracker — Database Schema (PostgreSQL + PostGIS)
-- Step 01 : Foundation
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
CREATE TYPE facility_type   AS ENUM ('central_hospital', 'clinic', 'field_point');
CREATE TYPE facility_status AS ENUM ('GREEN', 'RED');            -- حرفياً كما في المخطط (لا يوجد أصفر)
CREATE TYPE ambulance_state AS ENUM ('available', 'en_route', 'at_scene', 'transporting', 'offline');
CREATE TYPE incident_state  AS ENUM ('pending', 'assigned', 'resolved', 'failed_no_capacity');
CREATE TYPE mission_state   AS ENUM ('dispatched', 'arrived', 'completed', 'cancelled');

-- ---------------------------------------------------------------------
-- 1. المحافظات (Polygons)
-- ---------------------------------------------------------------------
CREATE TABLE governorates (
    id          SERIAL PRIMARY KEY,
    name_ar     TEXT NOT NULL,
    name_en     TEXT NOT NULL,
    boundary    GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    centroid    GEOGRAPHY(POINT, 4326)
);
CREATE INDEX idx_gov_boundary ON governorates USING GIST (boundary);

-- ---------------------------------------------------------------------
-- 2. المنشآت الطبية
-- ---------------------------------------------------------------------
CREATE TABLE facilities (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    type            facility_type NOT NULL,
    governorate_id  INT REFERENCES governorates(id),
    location        GEOGRAPHY(POINT, 4326) NOT NULL,
    total_beds      INT NOT NULL CHECK (total_beds >= 0),
    occupied_beds   INT NOT NULL DEFAULT 0 CHECK (occupied_beds >= 0),
    status          facility_status NOT NULL DEFAULT 'GREEN',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_occupancy_bounds CHECK (occupied_beds <= total_beds)
);
CREATE INDEX idx_fac_location ON facilities USING GIST (location);
CREATE INDEX idx_fac_gov      ON facilities (governorate_id);
CREATE INDEX idx_fac_status   ON facilities (status);

-- الأسرّة المتاحة ونسبة الإشغال كأعمدة محسوبة (الصندوق الأول في المخطط)
-- ملاحظة: حماية من القسمة على صفر عبر NULLIF
ALTER TABLE facilities
  ADD COLUMN available_beds INT GENERATED ALWAYS AS (total_beds - occupied_beds) STORED;

CREATE OR REPLACE FUNCTION occupancy_ratio(p_total INT, p_occupied INT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_occupied::NUMERIC / NULLIF(p_total, 0), 1.0) * 100;
$$;
-- إذا total = 0  ->  النسبة 100%  ->  الحالة RED (منشأة غير قادرة على الاستقبال)

-- ---------------------------------------------------------------------
-- 3. سيارات الإسعاف
-- ---------------------------------------------------------------------
CREATE TABLE ambulances (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT UNIQUE NOT NULL,
    governorate_id  INT REFERENCES governorates(id),
    location        GEOGRAPHY(POINT, 4326) NOT NULL,
    heading         NUMERIC,
    state           ambulance_state NOT NULL DEFAULT 'available',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_amb_location ON ambulances USING GIST (location);
CREATE INDEX idx_amb_state    ON ambulances (state);
CREATE INDEX idx_amb_gov      ON ambulances (governorate_id);

-- ---------------------------------------------------------------------
-- 4. البلاغات (نقطة البداية الناقصة في المخطط)
-- ---------------------------------------------------------------------
CREATE TABLE incidents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location        GEOGRAPHY(POINT, 4326) NOT NULL,
    governorate_id  INT REFERENCES governorates(id),
    severity        SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
    description     TEXT,
    state           incident_state NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX idx_inc_location ON incidents USING GIST (location);
CREATE INDEX idx_inc_state    ON incidents (state);
CREATE INDEX idx_inc_created  ON incidents (created_at DESC);

-- ---------------------------------------------------------------------
-- 5. المهام (Assign Route & Dispatch)
-- ---------------------------------------------------------------------
CREATE TABLE missions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id         UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    ambulance_id        UUID NOT NULL REFERENCES ambulances(id),
    facility_id         UUID NOT NULL REFERENCES facilities(id),
    route               GEOGRAPHY(LINESTRING, 4326),
    distance_meters     NUMERIC,
    eta_seconds         INT,
    state               mission_state NOT NULL DEFAULT 'dispatched',
    rejected_facilities UUID[] DEFAULT '{}',   -- المشافي المستبعدة في حلقة RED
    attempt_count       SMALLINT NOT NULL DEFAULT 1,
    is_manual_override  BOOLEAN NOT NULL DEFAULT FALSE, -- قرار يدوي من المدير
    dispatched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);
CREATE INDEX idx_mis_route     ON missions USING GIST (route);
CREATE INDEX idx_mis_state     ON missions (state);
CREATE INDEX idx_mis_ambulance ON missions (ambulance_id);

-- ---------------------------------------------------------------------
-- 6. السجل الزمني (Time-Machine)  — مقسّم شهرياً
-- ---------------------------------------------------------------------
CREATE TABLE facility_history (
    facility_id     UUID NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    total_beds      INT NOT NULL,
    occupied_beds   INT NOT NULL,
    occupancy_pct   NUMERIC(5,2) NOT NULL,
    status          facility_status NOT NULL
) PARTITION BY RANGE (recorded_at);

CREATE TABLE facility_history_2026_08 PARTITION OF facility_history
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_fh_time ON facility_history (recorded_at DESC, facility_id);

CREATE TABLE ambulance_history (
    ambulance_id    UUID NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    location        GEOGRAPHY(POINT, 4326) NOT NULL,
    state           ambulance_state NOT NULL
) PARTITION BY RANGE (recorded_at);

CREATE TABLE ambulance_history_2026_08 PARTITION OF ambulance_history
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_ah_time ON ambulance_history (recorded_at DESC, ambulance_id);
CREATE INDEX idx_ah_geo  ON ambulance_history USING GIST (location);

-- ---------------------------------------------------------------------
-- 7. التنبيهات
-- ---------------------------------------------------------------------
CREATE TABLE alerts (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    facility_id  UUID REFERENCES facilities(id),
    incident_id  UUID REFERENCES incidents(id),
    level        TEXT NOT NULL,
    message      TEXT NOT NULL,
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_created ON alerts (created_at DESC);

-- =====================================================================
-- الاستعلامات الجوهرية (30% من التقييم)
-- =====================================================================

-- (أ) إيجاد أقرب سيارة إسعاف متاحة — الصندوق [5] في المخطط
--     ST_Distance حرفياً كما ورد، مع ST_DWithin كفلتر يستفيد من الفهرس المكاني
CREATE OR REPLACE FUNCTION find_nearest_ambulance(
    p_incident_location GEOGRAPHY,
    p_radius_meters     NUMERIC DEFAULT 50000
)
RETURNS TABLE (ambulance_id UUID, code TEXT, distance_m NUMERIC)
LANGUAGE sql STABLE AS $$
    SELECT a.id,
           a.code,
           ST_Distance(a.location, p_incident_location)::NUMERIC
    FROM ambulances a
    WHERE a.state = 'available'
      AND ST_DWithin(a.location, p_incident_location, p_radius_meters)
    ORDER BY a.location <-> p_incident_location   -- KNN عبر فهرس GIST
    LIMIT 1;
$$;

-- (ب) إيجاد أقرب مشفى مؤهل — مع استبعاد المشافي المرفوضة في حلقة RED
CREATE OR REPLACE FUNCTION find_candidate_facility(
    p_incident_location GEOGRAPHY,
    p_excluded          UUID[] DEFAULT '{}'
)
RETURNS TABLE (facility_id UUID, name TEXT, occupancy_pct NUMERIC, distance_m NUMERIC)
LANGUAGE sql STABLE AS $$
    SELECT f.id,
           f.name,
           occupancy_ratio(f.total_beds, f.occupied_beds),
           ST_Distance(f.location, p_incident_location)::NUMERIC
    FROM facilities f
    WHERE NOT (f.id = ANY(p_excluded))
    ORDER BY f.location <-> p_incident_location
    LIMIT 1;
$$;

-- (ج) تجميع النقاط (Clustering) حسب مستوى التكبير — لخريطة الواجهة
CREATE OR REPLACE FUNCTION cluster_facilities(p_eps NUMERIC DEFAULT 0.15)
RETURNS TABLE (cluster_id INT, point_count BIGINT, center GEOMETRY, red_count BIGINT)
LANGUAGE sql STABLE AS $$
    WITH clustered AS (
        SELECT id, status,
               location::geometry AS g,
               ST_ClusterDBSCAN(location::geometry, eps := p_eps, minpoints := 2)
                   OVER () AS cid
        FROM facilities
    )
    SELECT COALESCE(cid, -1)::INT,
           COUNT(*),
           ST_Centroid(ST_Collect(g)),
           COUNT(*) FILTER (WHERE status = 'RED')
    FROM clustered
    GROUP BY COALESCE(cid, -1);
$$;

-- (د) الآلة الزمنية — لقطة الحالة في لحظة محددة بالماضي
CREATE OR REPLACE FUNCTION snapshot_at(p_ts TIMESTAMPTZ)
RETURNS TABLE (facility_id UUID, occupancy_pct NUMERIC, status facility_status)
LANGUAGE sql STABLE AS $$
    SELECT DISTINCT ON (fh.facility_id)
           fh.facility_id, fh.occupancy_pct, fh.status
    FROM facility_history fh
    WHERE fh.recorded_at <= p_ts
    ORDER BY fh.facility_id, fh.recorded_at DESC;
$$;

-- (هـ) عدد الحوادث داخل حدود محافظة (استعلام Polygon/Point)
CREATE OR REPLACE FUNCTION incidents_in_governorate(p_gov_id INT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)
    FROM incidents i
    JOIN governorates g ON g.id = p_gov_id
    WHERE ST_Within(i.location::geometry, g.boundary);
$$;

-- =====================================================================
-- تريغر: أرشفة كل تغيّر في الإشغال (يغذّي الآلة الزمنية)
-- =====================================================================
CREATE OR REPLACE FUNCTION log_facility_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO facility_history
        (facility_id, recorded_at, total_beds, occupied_beds, occupancy_pct, status)
    VALUES
        (NEW.id, now(), NEW.total_beds, NEW.occupied_beds,
         occupancy_ratio(NEW.total_beds, NEW.occupied_beds), NEW.status);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_facility_history
AFTER INSERT OR UPDATE OF occupied_beds, total_beds, status ON facilities
FOR EACH ROW EXECUTE FUNCTION log_facility_change();
