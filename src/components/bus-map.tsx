"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IconBus,
  IconCurrentLocation,
} from "@tabler/icons-react";
import L, {
  divIcon,
  latLngBounds,
  type DivIcon,
  type LatLngExpression,
} from "leaflet";
import "maplibre-gl";
import "@maplibre/maplibre-gl-leaflet";
import {
  Circle,
  MapContainer,
  Marker,
  Pane,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";

import { defaultMapProvider, type VectorStyleMapProvider } from "@/lib/map-config";
import type {
  GeolocationStatus,
  RouteShape,
  Stop,
  StopArrivalsResponse,
  UserLocation,
  VehiclePosition,
} from "@/lib/types";

type BusMapProps = {
  routes: RouteShape[];
  vehicles: VehiclePosition[];
  selectedStopId: string | null;
  selectedStopDetails: StopArrivalsResponse | null;
  onStopSelect: (stop: Stop) => void;
  provider?: VectorStyleMapProvider;
  highlightedLineId?: string | null;
  userLocation?: UserLocation | null;
  geolocationStatus?: GeolocationStatus;
  nearbyStops?: Stop[];
  nearbyStopIds?: Set<string>;
  focusUserLocationSignal?: number;
  focusNearbyStopsSignal?: number;
  onRequestUserLocation?: () => void;
  liveTrackingEnabled?: boolean;
  liveTrackingRouteId?: string | null;
  followedVehicleId?: string | null;
  onFollowVehicle?: (vehicle: VehiclePosition) => void;
};

type StopMarkerData = Stop & {
  colors: string[];
  routeIds: string[];
};

const MIN_STOP_ROUTE_OFFSET = 0.00003;
const MAX_STOP_ROUTE_OFFSET = 0.000075;
const HEADING_STILL_DISTANCE = 0.00001;
const HEADING_MAX_STEP_DEGREES = 40;
const HEADING_MAX_STEP_FAST_DEGREES = 62;
const HEADING_FAST_DISTANCE = 0.00018;
const UPSTREAM_HEADING_MAX_DELTA = 55;
const POSITION_ANIMATION_MIN_DURATION_MS = 2200;
const POSITION_ANIMATION_MAX_DURATION_MS = 5200;
const POSITION_ANIMATION_FOLLOW_MAX_DURATION_MS = 5600;
const POSITION_FREEZE_DISTANCE = 0.00001;
const POSITION_ANIMATION_MAX_DISTANCE = 0.0026;
const POSITION_ANIMATION_MAX_DISTANCE_FOR_DURATION = 0.00032;
const POSITION_ANIMATION_MIN_ROUTE_PROGRESS_DELTA = 0.0009;
const POSITION_ANIMATION_MAX_ROUTE_PROGRESS_DELTA = 0.22;

type VehicleMotionTrack = {
  routeId: string | null;
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  startAt: number;
  endAt: number;
  routePath?: Array<{ lat: number; lng: number }>;
  routeMetrics?: RoutePathMetrics;
  fromRouteProgress?: number;
  toRouteProgress?: number;
};

type RoutePathMetrics = {
  cumulative: number[];
  totalLength: number;
};

function getRouteRenderKey(route: RouteShape) {
  const firstPoint = route.path[0];
  const lastPoint = route.path[route.path.length - 1];

  return [
    route.lineId,
    route.routeId,
    route.directionLabel,
    route.isOutbound === null ? "na" : route.isOutbound ? "out" : "in",
    firstPoint ? `${firstPoint.lat},${firstPoint.lng}` : "start-na",
    lastPoint ? `${lastPoint.lat},${lastPoint.lng}` : "end-na",
  ].join("|");
}

function createStopIcon(
  colors: string[],
  isSelected: boolean,
  isNearby: boolean,
): DivIcon {
  const gradient =
    colors.length > 1
      ? `conic-gradient(${colors.join(",")})`
      : colors[0] ?? "#0f766e";

  return divIcon({
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16],
    html: `
      <span class="bus-stop-icon${isSelected ? " is-selected" : ""}${
        isNearby ? " is-nearby" : ""
      }" style="--stop-fill:${gradient}; --stop-accent:${colors[0] ?? "#0f766e"};">
        <span class="bus-stop-icon__inner"></span>
      </span>
    `,
  });
}

function createBusIcon(
  color: string,
  rotationDeg: number,
  liveTrackingEnabled: boolean,
  isFollowed: boolean,
): DivIcon {
  const directionRotation = Number.isFinite(rotationDeg)
    ? ((rotationDeg % 360) + 360) % 360
    : 0;
  const busIcon = renderToStaticMarkup(
    <IconBus size={20} strokeWidth={2} aria-hidden="true" focusable="false" />,
  );
  const directionIcon = `
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 6h5.1" />
      <path d="M5.6 3.5 9 6l-3.4 2.5" />
    </svg>
  `;

  return divIcon({
    className: "",
    iconSize: [50, 32],
    iconAnchor: [25, 16],
    popupAnchor: [0, -16],
    html: `
      <span class="bus-vehicle-icon${liveTrackingEnabled ? " is-live" : ""}${
        isFollowed ? " is-followed" : ""
      }" style="--route-color:${color}; --direction-rotation:${directionRotation}deg;">
        <span class="bus-vehicle-icon__shell">
          <span class="bus-vehicle-icon__bus">${busIcon}</span>
          <span class="bus-vehicle-icon__direction">${directionIcon}</span>
        </span>
      </span>
    `,
  });
}

function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

function getShortestAngleDelta(fromDeg: number, toDeg: number) {
  const normalizedFrom = normalizeDegrees(fromDeg);
  const normalizedTo = normalizeDegrees(toDeg);
  const rawDelta = normalizedTo - normalizedFrom;

  if (rawDelta > 180) {
    return rawDelta - 360;
  }

  if (rawDelta < -180) {
    return rawDelta + 360;
  }

  return rawDelta;
}

function getHeadingFromRouteSegment(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
) {
  // Convert geographic north-up coordinates into screen rotation (Y axis down).
  return (
    (Math.atan2(-(end.lat - start.lat), end.lng - start.lng) * 180) / Math.PI
  );
}

function getHeadingFromUpstreamDegrees(headingDegrees: number) {
  // Upstream heading is typically compass-based: 0° north, 90° east.
  // Bus marker direction uses screen rotation where 0° points right (east).
  return normalizeDegrees(90 - headingDegrees);
}

function clampHeadingStep(fromDeg: number, toDeg: number, maxStepDeg: number) {
  const delta = getShortestAngleDelta(fromDeg, toDeg);
  const limitedDelta = Math.max(-maxStepDeg, Math.min(maxStepDeg, delta));
  return normalizeDegrees(fromDeg + limitedDelta);
}

function getMotionTrackPosition(track: VehicleMotionTrack, now: number) {
  if (track.endAt <= track.startAt || now >= track.endAt) {
    return { lat: track.toLat, lng: track.toLng, isActive: false };
  }

  if (now <= track.startAt) {
    return { lat: track.fromLat, lng: track.fromLng, isActive: true };
  }

  const progress = (now - track.startAt) / (track.endAt - track.startAt);
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const easedProgress = 1 - Math.pow(1 - clampedProgress, 3);

  if (
    track.routePath &&
    track.routeMetrics &&
    track.fromRouteProgress !== undefined &&
    track.toRouteProgress !== undefined
  ) {
    const interpolatedProgress =
      track.fromRouteProgress +
      (track.toRouteProgress - track.fromRouteProgress) * easedProgress;
    const routePoint = getPointAtRouteProgress(
      track.routePath,
      track.routeMetrics,
      interpolatedProgress,
    );

    return {
      lat: routePoint.lat,
      lng: routePoint.lng,
      isActive: clampedProgress < 1,
    };
  }

  return {
    lat: track.fromLat + (track.toLat - track.fromLat) * easedProgress,
    lng: track.fromLng + (track.toLng - track.fromLng) * easedProgress,
    isActive: clampedProgress < 1,
  };
}

function getAdaptiveAnimationDurationMs(
  distance: number,
  routeProgressDelta: number | null,
  isFollowed: boolean,
) {
  const distanceRatio = Math.max(
    0,
    Math.min(1, distance / POSITION_ANIMATION_MAX_DISTANCE_FOR_DURATION),
  );
  const progressRatio =
    routeProgressDelta === null
      ? distanceRatio
      : Math.max(
          0,
          Math.min(
            1,
            routeProgressDelta / POSITION_ANIMATION_MAX_ROUTE_PROGRESS_DELTA,
          ),
        );
  const blendedRatio = Math.max(distanceRatio, progressRatio * 0.86);
  const baseDuration =
    POSITION_ANIMATION_MIN_DURATION_MS +
    (POSITION_ANIMATION_MAX_DURATION_MS - POSITION_ANIMATION_MIN_DURATION_MS) *
      blendedRatio;
  const followedDuration = isFollowed
    ? baseDuration + 380
    : baseDuration;
  const maxDuration = isFollowed
    ? POSITION_ANIMATION_FOLLOW_MAX_DURATION_MS
    : POSITION_ANIMATION_MAX_DURATION_MS;

  return Math.round(
    Math.max(POSITION_ANIMATION_MIN_DURATION_MS, Math.min(maxDuration, followedDuration)),
  );
}

function buildRoutePathMetrics(path: Array<{ lat: number; lng: number }>) {
  const cumulative = [0];
  let totalLength = 0;

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const segmentLength = Math.hypot(end.lat - start.lat, end.lng - start.lng);
    totalLength += segmentLength;
    cumulative.push(totalLength);
  }

  return {
    cumulative,
    totalLength,
  };
}

function getRouteProgressAtPoint(
  point: { lat: number; lng: number },
  path: Array<{ lat: number; lng: number }>,
  metrics: RoutePathMetrics,
) {
  if (path.length < 2 || metrics.totalLength <= 0) {
    return null;
  }

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAbsolute = 0;

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const projection = getProjectedPositionOnSegment(point, start, end);
    const segmentLength = metrics.cumulative[index + 1] - metrics.cumulative[index];
    const absoluteProgress = metrics.cumulative[index] + segmentLength * projection.t;

    if (projection.distance < bestDistance) {
      bestDistance = projection.distance;
      bestAbsolute = absoluteProgress;
    }
  }

  return bestAbsolute / metrics.totalLength;
}

function getPointAtRouteProgress(
  path: Array<{ lat: number; lng: number }>,
  metrics: RoutePathMetrics,
  progress: number,
) {
  if (path.length < 2 || metrics.totalLength <= 0) {
    return {
      lat: path[0]?.lat ?? 0,
      lng: path[0]?.lng ?? 0,
    };
  }

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const targetDistance = metrics.totalLength * clampedProgress;

  let segmentIndex = 0;
  while (
    segmentIndex < metrics.cumulative.length - 2 &&
    metrics.cumulative[segmentIndex + 1] < targetDistance
  ) {
    segmentIndex += 1;
  }

  const start = path[segmentIndex];
  const end = path[segmentIndex + 1] ?? start;
  const segmentStartDistance = metrics.cumulative[segmentIndex];
  const segmentEndDistance = metrics.cumulative[segmentIndex + 1] ?? segmentStartDistance;
  const segmentLength = segmentEndDistance - segmentStartDistance;

  if (segmentLength <= 1e-9) {
    return { lat: start.lat, lng: start.lng };
  }

  const segmentProgress = (targetDistance - segmentStartDistance) / segmentLength;
  const clampedSegmentProgress = Math.max(0, Math.min(1, segmentProgress));

  return {
    lat: start.lat + (end.lat - start.lat) * clampedSegmentProgress,
    lng: start.lng + (end.lng - start.lng) * clampedSegmentProgress,
  };
}

const userLocationIcon = divIcon({
  className: "",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  html: `
    <span class="user-location-icon">
      <span class="user-location-icon__dot"></span>
    </span>
  `,
});

function OpenFreeMapLayer({ provider }: { provider: VectorStyleMapProvider }) {
  const map = useMap();

  useEffect(() => {
    if (!map.getPane("basemap")) {
      map.createPane("basemap");
    }

    const basemapPane = map.getPane("basemap");
    if (basemapPane) {
      basemapPane.style.zIndex = "100";
    }

    const layer = L.maplibreGL({
      style: provider.styleUrl,
      attribution: provider.attribution,
      pane: "basemap",
      interactive: false,
    });

    layer.addTo(map);

    return () => {
      layer.remove();
    };
  }, [map, provider]);

  return null;
}

function RecenterControl({
  userLocation,
  geolocationStatus,
  onRequestUserLocation,
}: {
  userLocation?: UserLocation | null;
  geolocationStatus?: GeolocationStatus;
  onRequestUserLocation?: () => void;
}) {
  const map = useMap();

  return (
    <button
      type="button"
      className="map-recenter-button"
      aria-label="Centrar en mi ubicacion"
      title="Centrar en mi ubicacion"
      onClick={() => {
        if (userLocation) {
          map.flyTo([userLocation.lat, userLocation.lng], Math.max(map.getZoom(), 16), {
            duration: 0.8,
          });
          return;
        }

        onRequestUserLocation?.();
      }}
      data-state={geolocationStatus ?? "idle"}
    >
      <IconCurrentLocation
        size={18}
        strokeWidth={2.1}
        aria-hidden="true"
        focusable="false"
      />
    </button>
  );
}

function FitToRoutes({ routes }: { routes: RouteShape[] }) {
  const map = useMap();

  useEffect(() => {
    if (routes.length === 0) {
      return;
    }

    const points = routes.flatMap((route) => route.path);
    if (points.length === 0) {
      return;
    }

    const bounds = latLngBounds(
      points.map((point) => [point.lat, point.lng] as LatLngExpression),
    );

    const latSpan = Math.abs(bounds.getNorth() - bounds.getSouth());
    const lngSpan = Math.abs(bounds.getEast() - bounds.getWest());
    const dominantSpan = Math.max(latSpan, lngSpan);
    const mapSize = map.getSize();
    const isCompactViewport = mapSize.x <= 720;

    // Keep the selected line comfortably inside the visible map area, accounting
    // for the route legend and stop panel overlays without over-zooming short lines.
    const paddingTopLeft: [number, number] = isCompactViewport ? [24, 72] : [72, 72];
    const paddingBottomRight: [number, number] = isCompactViewport ? [24, 24] : [48, 40];

    let maxZoom = 17;
    if (dominantSpan < 0.015) {
      maxZoom = 15;
    } else if (dominantSpan < 0.035) {
      maxZoom = 16;
    }

    map.fitBounds(bounds, {
      paddingTopLeft,
      paddingBottomRight,
      maxZoom,
    });
  }, [map, routes]);

  return null;
}

function FocusUserLocation({
  userLocation,
  signal,
}: {
  userLocation?: UserLocation | null;
  signal?: number;
}) {
  const map = useMap();
  const lastHandledSignalRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!signal || !userLocation || lastHandledSignalRef.current === signal) {
      return;
    }

    lastHandledSignalRef.current = signal;
    map.flyTo([userLocation.lat, userLocation.lng], Math.max(map.getZoom(), 16), {
      duration: 0.8,
    });
  }, [map, signal, userLocation]);

  return null;
}

function FocusNearbyStops({
  userLocation,
  nearbyStops,
  signal,
}: {
  userLocation?: UserLocation | null;
  nearbyStops: Stop[];
  signal?: number;
}) {
  const map = useMap();
  const lastHandledSignalRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!signal || !userLocation || lastHandledSignalRef.current === signal) {
      return;
    }

    lastHandledSignalRef.current = signal;
    if (nearbyStops.length === 0) {
      map.flyTo([userLocation.lat, userLocation.lng], Math.max(map.getZoom(), 16), {
        duration: 0.8,
      });
      return;
    }

    const bounds = latLngBounds([
      [userLocation.lat, userLocation.lng] as LatLngExpression,
      ...nearbyStops.map((stop) => [stop.lat, stop.lng] as LatLngExpression),
    ]);

    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 });
  }, [map, nearbyStops, signal, userLocation]);

  return null;
}

function FocusFollowedVehicle({
  vehicle,
  followedVehicleId,
}: {
  vehicle?: { markerLat: number; markerLng: number } | null;
  followedVehicleId?: string | null;
}) {
  const map = useMap();
  const lastFocusedVehicleIdRef = useRef<string | null>(null);
  const lastHandledPositionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!followedVehicleId || !vehicle) {
      lastFocusedVehicleIdRef.current = followedVehicleId ?? null;
      lastHandledPositionRef.current = null;
      return;
    }

    const nextPositionKey = `${vehicle.markerLat.toFixed(6)},${vehicle.markerLng.toFixed(6)}`;
    const vehicleLatLng = L.latLng(vehicle.markerLat, vehicle.markerLng);
    const currentCenter = map.getCenter();

    if (lastFocusedVehicleIdRef.current !== followedVehicleId) {
      lastFocusedVehicleIdRef.current = followedVehicleId;
      lastHandledPositionRef.current = nextPositionKey;
      const targetZoom = Math.min(
        map.getMaxZoom(),
        Math.max(map.getZoom(), 16.8),
      );

      map.flyTo([vehicle.markerLat, vehicle.markerLng], targetZoom, {
        duration: 0.75,
        easeLinearity: 0.25,
      });
      return;
    }

    if (lastHandledPositionRef.current === nextPositionKey) {
      return;
    }

    lastHandledPositionRef.current = nextPositionKey;

    const centerPoint = map.latLngToContainerPoint(currentCenter);
    const vehiclePoint = map.latLngToContainerPoint(vehicleLatLng);
    const pixelDelta = centerPoint.distanceTo(vehiclePoint);
    const mapSize = map.getSize();
    const recenterThreshold = Math.max(
      72,
      Math.min(mapSize.x, mapSize.y) * 0.22,
    );

    if (pixelDelta <= recenterThreshold) {
      return;
    }

    map.panTo([vehicle.markerLat, vehicle.markerLng], {
      animate: true,
      duration: 0.65,
      easeLinearity: 0.25,
    });
  }, [followedVehicleId, map, vehicle]);

  return null;
}

function dedupeStops(routes: RouteShape[]) {
  const seen = new Map<string, StopMarkerData>();

  routes.forEach((route) => {
    route.stops.forEach((stop) => {
      const existing = seen.get(stop.id);

      if (existing) {
        if (!existing.colors.includes(route.colorHint)) {
          existing.colors.push(route.colorHint);
        }
        if (!existing.routeIds.includes(route.routeId)) {
          existing.routeIds.push(route.routeId);
        }
        return;
      }

      seen.set(stop.id, {
        ...stop,
        colors: [route.colorHint],
        routeIds: [route.routeId],
      });
    });
  });

  return [...seen.values()];
}

function mergeNearbyStops(baseStops: StopMarkerData[], nearbyStops: Stop[]) {
  const merged = new Map(baseStops.map((stop) => [stop.id, stop]));

  nearbyStops.forEach((stop) => {
    const existing = merged.get(stop.id);
    if (existing) {
      return;
    }

    merged.set(stop.id, {
      ...stop,
      colors: ["#34d399"],
      routeIds: [],
    });
  });

  return [...merged.values()];
}

function getProjectedPositionOnSegment(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
) {
  const segmentDx = end.lng - start.lng;
  const segmentDy = end.lat - start.lat;
  const segmentLengthSquared = segmentDx * segmentDx + segmentDy * segmentDy;

  if (segmentLengthSquared === 0) {
    return {
      distance: Math.hypot(point.lat - start.lat, point.lng - start.lng),
      lat: start.lat,
      lng: start.lng,
      t: 0,
      dx: 0,
      dy: 0,
    };
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.lng - start.lng) * segmentDx + (point.lat - start.lat) * segmentDy) /
        segmentLengthSquared,
    ),
  );

  const projectedLng = start.lng + segmentDx * t;
  const projectedLat = start.lat + segmentDy * t;

  return {
    distance: Math.hypot(point.lat - projectedLat, point.lng - projectedLng),
    lat: projectedLat,
    lng: projectedLng,
    t,
    dx: segmentDx,
    dy: segmentDy,
  };
}

function getStopPlacement(stop: StopMarkerData, candidateRoutes: RouteShape[]) {
  if (candidateRoutes.length === 0) {
    return { lat: stop.lat, lng: stop.lng };
  }

  let bestMatch:
    | {
        distance: number;
        lat: number;
        lng: number;
        dx: number;
        dy: number;
      }
    | undefined;

  candidateRoutes.forEach((route) => {
    if (route.path.length < 2) {
      return;
    }

    for (let index = 0; index < route.path.length - 1; index += 1) {
      const start = route.path[index];
      const end = route.path[index + 1];
      const projection = getProjectedPositionOnSegment(stop, start, end);

      if (!bestMatch || projection.distance < bestMatch.distance) {
        bestMatch = projection;
      }
    }
  });

  if (!bestMatch) {
    return { lat: stop.lat, lng: stop.lng };
  }

  if (
    bestMatch.distance >= MIN_STOP_ROUTE_OFFSET &&
    bestMatch.distance <= MAX_STOP_ROUTE_OFFSET
  ) {
    return { lat: stop.lat, lng: stop.lng };
  }

  const offsetDistance =
    bestMatch.distance > MAX_STOP_ROUTE_OFFSET
      ? Math.max(
          MIN_STOP_ROUTE_OFFSET,
          Math.min(MAX_STOP_ROUTE_OFFSET, bestMatch.distance * 0.35),
        )
      : MIN_STOP_ROUTE_OFFSET;

  let offsetLat = stop.lat - bestMatch.lat;
  let offsetLng = stop.lng - bestMatch.lng;
  const offsetLength = Math.hypot(offsetLat, offsetLng);

  if (offsetLength < 1e-9) {
    const normalLength = Math.hypot(bestMatch.dx, bestMatch.dy) || 1;
    offsetLat = bestMatch.dx / normalLength;
    offsetLng = -bestMatch.dy / normalLength;
  } else {
    offsetLat /= offsetLength;
    offsetLng /= offsetLength;
  }

  return {
    lat: bestMatch.lat + offsetLat * offsetDistance,
    lng: bestMatch.lng + offsetLng * offsetDistance,
  };
}

function getVehiclePlacement(
  vehicle: VehiclePosition,
  route: RouteShape | undefined,
) {
  const rawHeading = vehicle.headingDegrees;
  const upstreamHeading =
    typeof rawHeading === "number" && Number.isFinite(rawHeading)
      ? getHeadingFromUpstreamDegrees(rawHeading)
      : null;

  if (!route || route.path.length < 2) {
    return {
      heading: upstreamHeading ?? 0,
      lat: vehicle.lat,
      lng: vehicle.lng,
    };
  }

  let bestPlacement:
    | {
        distance: number;
        heading: number;
        lat: number;
        lng: number;
      }
    | undefined;

  for (let index = 0; index < route.path.length - 1; index += 1) {
    const start = route.path[index];
    const end = route.path[index + 1];
    const projection = getProjectedPositionOnSegment(vehicle, start, end);
    const heading = getHeadingFromRouteSegment(start, end);

    if (!bestPlacement || projection.distance < bestPlacement.distance) {
      bestPlacement = {
        distance: projection.distance,
        heading,
        lat: projection.lat,
        lng: projection.lng,
      };
    }
  }

  if (!bestPlacement) {
    return {
      heading: upstreamHeading ?? 0,
      lat: vehicle.lat,
      lng: vehicle.lng,
    };
  }

  const routeHeading = normalizeDegrees(bestPlacement.heading);
  const headingToRender =
    upstreamHeading !== null &&
    Math.abs(getShortestAngleDelta(routeHeading, upstreamHeading)) <=
      UPSTREAM_HEADING_MAX_DELTA
      ? upstreamHeading
      : routeHeading;

  return {
    heading: headingToRender,
    lat: bestPlacement.lat,
    lng: bestPlacement.lng,
  };
}

export function BusMap({
  routes,
  vehicles,
  selectedStopId,
  selectedStopDetails,
  onStopSelect,
  provider = defaultMapProvider,
  userLocation,
  geolocationStatus = "idle",
  nearbyStops = [],
  nearbyStopIds = new Set<string>(),
  focusUserLocationSignal,
  focusNearbyStopsSignal,
  onRequestUserLocation,
  liveTrackingEnabled = false,
  liveTrackingRouteId = null,
  followedVehicleId = null,
  onFollowVehicle,
}: BusMapProps) {
  const vehicleHeadingStateRef = useRef<
    Map<string, { heading: number; lat: number; lng: number }>
  >(new Map());
  const vehicleMotionTracksRef = useRef<Map<string, VehicleMotionTrack>>(new Map());
  const positionAnimationFrameRef = useRef<number | null>(null);
  const [positionAnimationTick, setPositionAnimationTick] = useState(0);
  const startPositionAnimationLoop = () => {
    if (positionAnimationFrameRef.current !== null) {
      return;
    }

    const loop = () => {
      const now = performance.now();
      const hasActiveTrack = [...vehicleMotionTracksRef.current.values()].some(
        (track) => now < track.endAt,
      );

      setPositionAnimationTick(now);

      if (hasActiveTrack) {
        positionAnimationFrameRef.current = window.requestAnimationFrame(loop);
      } else {
        positionAnimationFrameRef.current = null;
      }
    };

    positionAnimationFrameRef.current = window.requestAnimationFrame(loop);
  };
  const visibleRoutes = useMemo(
    () =>
      liveTrackingEnabled && liveTrackingRouteId
        ? routes.filter((route) => route.routeId === liveTrackingRouteId)
        : routes,
    [liveTrackingEnabled, liveTrackingRouteId, routes],
  );
  const visibleVehicles = useMemo(
    () =>
      liveTrackingEnabled && liveTrackingRouteId
        ? vehicles.filter((vehicle) => vehicle.routeId === liveTrackingRouteId)
        : vehicles,
    [liveTrackingEnabled, liveTrackingRouteId, vehicles],
  );
  const stops = useMemo(
    () => mergeNearbyStops(dedupeStops(visibleRoutes), nearbyStops),
    [nearbyStops, visibleRoutes],
  );
  const routesById = useMemo(
    () => new Map(visibleRoutes.map((route) => [route.routeId, route])),
    [visibleRoutes],
  );
  const routeMetricsById = useMemo(() => {
    const map = new Map<string, RoutePathMetrics>();

    visibleRoutes.forEach((route) => {
      if (route.path.length < 2) {
        return;
      }

      const metrics = buildRoutePathMetrics(route.path);
      if (metrics.totalLength > 0) {
        map.set(route.routeId, metrics);
      }
    });

    return map;
  }, [visibleRoutes]);
  const positionedStops = useMemo(
    () =>
      stops.map((stop) => {
        const candidateRoutes = stop.routeIds
          .map((routeId) => routesById.get(routeId))
          .filter((route): route is RouteShape => Boolean(route));
        const placement = getStopPlacement(stop, candidateRoutes);

        return {
          ...stop,
          markerLat: placement.lat,
          markerLng: placement.lng,
        };
      }),
    [routesById, stops],
  );
  const routePositionedVehicles = useMemo(
    () =>
      visibleVehicles.map((vehicle) => {
        const route = routesById.get(vehicle.routeId ?? "");
        const placement = getVehiclePlacement(vehicle, route);

        return {
          ...vehicle,
          markerHeading: placement.heading,
          markerLat: placement.lat,
          markerLng: placement.lng,
          routeColor: route?.colorHint ?? "#dc2626",
          routeLabel: route?.directionLabel ?? null,
        };
      }),
    [routesById, visibleVehicles],
  );
  const headingSmoothedVehicles = useMemo(() => {
    const nextHeadingState = new Map<
      string,
      { heading: number; lat: number; lng: number }
    >();

    const smoothedVehicles = routePositionedVehicles.map((vehicle) => {
      const previousHeading = vehicleHeadingStateRef.current.get(vehicle.vehicleId);
      const targetHeading = normalizeDegrees(vehicle.markerHeading);
      let headingForRender = targetHeading;

      if (previousHeading) {
        const movementDistance = Math.hypot(
          vehicle.markerLat - previousHeading.lat,
          vehicle.markerLng - previousHeading.lng,
        );

        if (movementDistance <= HEADING_STILL_DISTANCE) {
          headingForRender = previousHeading.heading;
        } else {
          const maxStep =
            movementDistance > HEADING_FAST_DISTANCE
              ? HEADING_MAX_STEP_FAST_DEGREES
              : HEADING_MAX_STEP_DEGREES;
          headingForRender = clampHeadingStep(
            previousHeading.heading,
            targetHeading,
            maxStep,
          );
        }
      }

      nextHeadingState.set(vehicle.vehicleId, {
        heading: headingForRender,
        lat: vehicle.markerLat,
        lng: vehicle.markerLng,
      });

      return {
        ...vehicle,
        markerHeading: headingForRender,
      };
    });

    vehicleHeadingStateRef.current = nextHeadingState;

    return smoothedVehicles;
  }, [routePositionedVehicles]);
  useEffect(() => {
    const now = performance.now();
    const previousTracks = vehicleMotionTracksRef.current;
    const nextTracks = new Map<string, VehicleMotionTrack>();

    headingSmoothedVehicles.forEach((vehicle) => {
      const previousTrack = previousTracks.get(vehicle.vehicleId);
      const previousPosition = previousTrack
        ? getMotionTrackPosition(previousTrack, now)
        : null;
      const fromLat = previousPosition?.lat ?? vehicle.markerLat;
      const fromLng = previousPosition?.lng ?? vehicle.markerLng;
      const distanceToNext = Math.hypot(
        vehicle.markerLat - fromLat,
        vehicle.markerLng - fromLng,
      );
      const isRouteSwitch =
        previousTrack !== undefined && previousTrack.routeId !== vehicle.routeId;
      const shouldFreeze = distanceToNext <= POSITION_FREEZE_DISTANCE;
      const shouldSnap =
        distanceToNext > POSITION_ANIMATION_MAX_DISTANCE || isRouteSwitch;
      const shouldAnimate =
        previousTrack !== undefined && !shouldFreeze && !shouldSnap;

      const route = vehicle.routeId ? routesById.get(vehicle.routeId) : undefined;
      const routeMetrics = vehicle.routeId
        ? routeMetricsById.get(vehicle.routeId)
        : undefined;
      const supportsRouteGuidedInterpolation =
        previousTrack !== undefined &&
        previousTrack.routeId === vehicle.routeId &&
        route !== undefined &&
        routeMetrics !== undefined &&
        route.path.length >= 2;
      const fromProgress =
        supportsRouteGuidedInterpolation && previousPosition
          ? getRouteProgressAtPoint(previousPosition, route.path, routeMetrics)
          : null;
      const toProgress =
        supportsRouteGuidedInterpolation
          ? getRouteProgressAtPoint(
              { lat: vehicle.markerLat, lng: vehicle.markerLng },
              route.path,
              routeMetrics,
            )
          : null;
      const canAnimateOnRoute =
        fromProgress !== null &&
        toProgress !== null &&
        Math.abs(toProgress - fromProgress) >=
          POSITION_ANIMATION_MIN_ROUTE_PROGRESS_DELTA &&
        Math.abs(toProgress - fromProgress) <=
          POSITION_ANIMATION_MAX_ROUTE_PROGRESS_DELTA;
      const routeProgressDelta =
        canAnimateOnRoute && fromProgress !== null && toProgress !== null
          ? Math.abs(toProgress - fromProgress)
          : null;
      const routePathForAnimation =
        canAnimateOnRoute && route ? route.path : undefined;
      const routeMetricsForAnimation =
        canAnimateOnRoute && routeMetrics ? routeMetrics : undefined;
      const animationDurationMs = getAdaptiveAnimationDurationMs(
        distanceToNext,
        routeProgressDelta,
        vehicle.vehicleId === followedVehicleId,
      );

      if (!shouldAnimate) {
        nextTracks.set(vehicle.vehicleId, {
          routeId: vehicle.routeId,
          fromLat: vehicle.markerLat,
          fromLng: vehicle.markerLng,
          toLat: vehicle.markerLat,
          toLng: vehicle.markerLng,
          startAt: now,
          endAt: now,
          routePath: route?.path,
          routeMetrics,
          fromRouteProgress: toProgress ?? undefined,
          toRouteProgress: toProgress ?? undefined,
        });
        return;
      }

      nextTracks.set(vehicle.vehicleId, {
        routeId: vehicle.routeId,
        fromLat,
        fromLng,
        toLat: vehicle.markerLat,
        toLng: vehicle.markerLng,
        startAt: now,
        endAt: now + animationDurationMs,
        routePath: routePathForAnimation,
        routeMetrics: routeMetricsForAnimation,
        fromRouteProgress: canAnimateOnRoute ? fromProgress : undefined,
        toRouteProgress: canAnimateOnRoute ? toProgress : undefined,
      });
    });

    vehicleMotionTracksRef.current = nextTracks;
    setPositionAnimationTick(now);
    const hasPendingTrack = [...nextTracks.values()].some(
      (track) => track.endAt > track.startAt,
    );
    if (hasPendingTrack) {
      startPositionAnimationLoop();
    } else if (positionAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(positionAnimationFrameRef.current);
      positionAnimationFrameRef.current = null;
    }
  }, [followedVehicleId, headingSmoothedVehicles, routeMetricsById, routesById]);

  useEffect(() => {
    return () => {
      if (positionAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(positionAnimationFrameRef.current);
        positionAnimationFrameRef.current = null;
      }
    };
  }, []);

  const positionedVehicles = useMemo(() => {
    const now = positionAnimationTick || performance.now();

    return headingSmoothedVehicles.map((vehicle) => {
      const track = vehicleMotionTracksRef.current.get(vehicle.vehicleId);
      if (!track) {
        return vehicle;
      }

      const currentPosition = getMotionTrackPosition(track, now);

      return {
        ...vehicle,
        markerLat: currentPosition.lat,
        markerLng: currentPosition.lng,
      };
    });
  }, [headingSmoothedVehicles, positionAnimationTick]);
  const followedVehicleForFocus = useMemo(
    () =>
      followedVehicleId
        ? headingSmoothedVehicles.find(
            (vehicle) => vehicle.vehicleId === followedVehicleId,
          ) ?? null
        : null,
    [followedVehicleId, headingSmoothedVehicles],
  );

  return (
    <div className="map-shell">
      <MapContainer
        center={[provider.center.lat, provider.center.lng]}
        zoom={provider.zoom}
        minZoom={provider.minZoom}
        maxZoom={provider.maxZoom}
        zoomControl={false}
        className="leaflet-map"
      >
        <OpenFreeMapLayer provider={provider} />
        <FitToRoutes routes={visibleRoutes} />
        <FocusUserLocation
          userLocation={userLocation}
          signal={focusUserLocationSignal}
        />
        <FocusNearbyStops
          userLocation={userLocation}
          nearbyStops={nearbyStops}
          signal={focusNearbyStopsSignal}
        />
        <FocusFollowedVehicle
          vehicle={followedVehicleForFocus}
          followedVehicleId={followedVehicleId}
        />
        <RecenterControl
          userLocation={userLocation}
          geolocationStatus={geolocationStatus}
          onRequestUserLocation={onRequestUserLocation}
        />

        <Pane name="routes" style={{ zIndex: 410 }}>
          {visibleRoutes.map((route, index) => {
            const routeRenderKey = `${getRouteRenderKey(route)}|${index}`;

            return (
              <Fragment key={routeRenderKey}>
                <Polyline
                  key={`${routeRenderKey}-shadow`}
                  positions={route.path.map(
                    (point) => [point.lat, point.lng] as LatLngExpression,
                  )}
                  pathOptions={{
                    color: "rgba(8, 12, 16, 0.34)",
                    weight: 7,
                    opacity: 0.72,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
                <Polyline
                  key={`${routeRenderKey}-main`}
                  positions={route.path.map(
                    (point) => [point.lat, point.lng] as LatLngExpression,
                  )}
                  pathOptions={{
                    color: route.colorHint,
                    weight: 4.5,
                    opacity: 0.9,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
              </Fragment>
            );
          })}
        </Pane>

        <Pane name="stops" style={{ zIndex: 650 }}>
          {positionedStops.map((stop) => (
            <Marker
              key={stop.id}
              position={[stop.markerLat, stop.markerLng]}
              icon={createStopIcon(
                stop.colors,
                stop.id === selectedStopId,
                nearbyStopIds.has(stop.id),
              )}
              eventHandlers={{
                click: () => onStopSelect(stop),
              }}
            />
          ))}
        </Pane>

        <Pane name="vehicles" style={{ zIndex: 720 }}>
          {positionedVehicles.map((vehicle) => (
            <Marker
              key={vehicle.vehicleId}
              position={[vehicle.markerLat, vehicle.markerLng]}
              zIndexOffset={vehicle.vehicleId === followedVehicleId ? 120 : 0}
              icon={createBusIcon(
                vehicle.routeColor,
                vehicle.markerHeading,
                liveTrackingEnabled,
                vehicle.vehicleId === followedVehicleId,
              )}
            >
              {vehicle.vehicleId !== followedVehicleId ? (
                <Popup
                  className="vehicle-follow-popup"
                  closeButton={false}
                  offset={[0, -16]}
                >
                  <div className="vehicle-popup">
                    <button
                      type="button"
                      className="vehicle-popup__button"
                      onClick={() => {
                        onFollowVehicle?.(vehicle);
                      }}
                    >
                      Seguir bus
                    </button>
                  </div>
                </Popup>
              ) : null}
            </Marker>
          ))}
        </Pane>

        {userLocation ? (
          <Pane name="user-location" style={{ zIndex: 760 }}>
            {userLocation.accuracy ? (
              <Circle
                center={[userLocation.lat, userLocation.lng]}
                radius={userLocation.accuracy}
                pathOptions={{
                  color: "#2563eb",
                  fillColor: "#60a5fa",
                  fillOpacity: 0.12,
                  weight: 1,
                }}
              />
            ) : null}

            <Marker
              position={[userLocation.lat, userLocation.lng]}
              icon={userLocationIcon}
            />
          </Pane>
        ) : null}
      </MapContainer>

      <div className="map-legend">
        <span>Base cartográfica: {provider.name}</span>
        <span>Paradas visibles: {stops.length}</span>
        <span>Vehículos activos: {vehicles.length}</span>
        <span>Llegadas mostradas: {selectedStopDetails?.arrivals.length ?? 0}</span>
      </div>
    </div>
  );
}
