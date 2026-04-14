"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IconBus,
  IconChevronRight,
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
  const normalizedHeading = ((rotationDeg % 360) + 360) % 360;
  const directionFlip = normalizedHeading > 90 && normalizedHeading < 270 ? -1 : 1;
  const busIcon = renderToStaticMarkup(
    <IconBus size={20} strokeWidth={2} aria-hidden="true" focusable="false" />,
  );
  const directionIcon = renderToStaticMarkup(
    <IconChevronRight size={9} strokeWidth={2.4} aria-hidden="true" focusable="false" />,
  );

  return divIcon({
    className: "",
    iconSize: [50, 32],
    iconAnchor: [25, 16],
    popupAnchor: [0, -16],
    html: `
      <span class="bus-vehicle-icon${liveTrackingEnabled ? " is-live" : ""}${
        isFollowed ? " is-followed" : ""
      }" style="--route-color:${color}; --direction-flip:${directionFlip};">
        <span class="bus-vehicle-icon__shell">
          <span class="bus-vehicle-icon__bus">${busIcon}</span>
          <span class="bus-vehicle-icon__direction">${directionIcon}</span>
        </span>
      </span>
    `,
  });
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
  if (!route || route.path.length < 2) {
    return {
      heading: vehicle.headingDegrees ?? 0,
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
    const heading = (Math.atan2(end.lat - start.lat, end.lng - start.lng) * 180) / Math.PI;

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
      heading: vehicle.headingDegrees ?? 0,
      lat: vehicle.lat,
      lng: vehicle.lng,
    };
  }

  return {
    heading:
      Number.isFinite(vehicle.headingDegrees) &&
      Math.abs((vehicle.headingDegrees ?? 0) - bestPlacement.heading) < 120
        ? (vehicle.headingDegrees ?? 0)
        : bestPlacement.heading,
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
  const positionedVehicles = useMemo(
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
  const followedVehicle = useMemo(
    () =>
      followedVehicleId
        ? positionedVehicles.find((vehicle) => vehicle.vehicleId === followedVehicleId) ??
          null
        : null,
    [followedVehicleId, positionedVehicles],
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
          vehicle={followedVehicle}
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
