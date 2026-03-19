export type Line = {
  id: string;
  publicCode: string;
  displayName: string;
  source: "isaenext";
};

export type Stop = {
  id: string;
  code: string | null;
  name: string;
  lat: number;
  lng: number;
  type: number | string | null;
  source: "isaenext";
};

export type RouteStop = Stop & {
  sequence: number;
  routeId: string;
  directionLabel: string;
  isTerminal: boolean;
};

export type RouteShape = {
  routeId: string;
  lineId: string;
  directionLabel: string;
  isOutbound: boolean | null;
  colorHint: string;
  path: Array<{ lat: number; lng: number }>;
  stops: RouteStop[];
};

export type VehiclePosition = {
  vehicleId: string;
  lineId: string;
  routeId: string | null;
  lat: number;
  lng: number;
  headingDegrees?: number | null;
  offsetSeconds: number | null;
  offsetMeters: number | null;
  observedAt: string;
  source: "isaenext";
};

export type ArrivalPrediction = {
  stopId: string;
  lineId: string;
  destination: string;
  vehicleId: string | null;
  etaSeconds: number;
  distanceMeters: number | null;
  isLastBus: boolean | null;
  isPartialTrip: boolean | null;
  observedAt: string;
  source: "isaenext";
};

export type LineDetail = Line & {
  routes: RouteShape[];
};

export type StopArrivalsResponse = {
  stop: Stop;
  lines: Line[];
  arrivals: ArrivalPrediction[];
  observedAt: string;
};
