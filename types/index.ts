// types/index.ts

export type FacilityType = 'central_hospital' | 'clinic' | 'field_point';
export type FacilityStatus = 'GREEN' | 'RED';
export type AmbulanceState =
  | 'available' | 'en_route' | 'at_scene' | 'transporting' | 'offline';

export interface LatLng {
  lat: number;
  lon: number;
}

export interface Facility {
  id: string;
  name: string;
  type: FacilityType;
  governorate_id: number;
  lat: number;
  lon: number;
  total_beds: number;
  occupied_beds: number;
  available_beds: number;
  status: FacilityStatus;
}

export interface Ambulance {
  id: string;
  code: string;
  governorate_id: number;
  lat: number;
  lon: number;
  state: AmbulanceState;
}

export interface Incident {
  id: string;
  lat: number;
  lon: number;
  severity: 1 | 2 | 3 | 4 | 5;
  description: string | null;
}

/** نتيجة تنفيذ المخطط الانسيابي */
export type DispatchOutcome =
  | {
      status: 'DISPATCHED';
      ambulanceId: string;
      ambulanceCode: string;
      facilityId: string;
      facilityName: string;
      distanceMeters: number;
      etaSeconds: number;
      rejectedFacilities: string[];
      attempts: number;
      trace: string[];
    }
  | {
      status: 'NO_AMBULANCE_AVAILABLE' | 'NO_CAPACITY_AVAILABLE';
      reason: string;
      rejectedFacilities: string[];
      attempts: number;
      trace: string[];
    };

/** واجهة الوصول للبيانات — تُحقن في المحرك ليبقى قابلاً للاختبار */
export interface DispatchDataSource {
  findNearestAmbulance(
    location: LatLng,
    radiusMeters?: number
  ): Promise<{ id: string; code: string; distanceMeters: number } | null>;

  findCandidateFacility(
    location: LatLng,
    excluded: string[]
  ): Promise<{
    id: string;
    name: string;
    totalBeds: number;
    occupiedBeds: number;
    distanceMeters: number;
  } | null>;

  setFacilityStatus(facilityId: string, status: FacilityStatus): Promise<void>;

  triggerAlert(facilityId: string, message: string): Promise<void>;

  assignRouteAndDispatch(input: {
    incidentId: string;
    ambulanceId: string;
    facilityId: string;
    distanceMeters: number;
    etaSeconds: number;
    rejectedFacilities: string[];
    attempts: number;
  }): Promise<void>;
}
