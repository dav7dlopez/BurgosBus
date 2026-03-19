"use client";

import { useEffect, useMemo } from "react";
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
};

type StopMarkerData = Stop & {
  colors: string[];
};

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
      }" style="--stop-fill:${gradient}">
        <span class="bus-stop-icon__pole"></span>
      </span>
    `,
  });
}

function createBusIcon(color: string, rotationDeg: number): DivIcon {
  return divIcon({
    className: "",
    iconSize: [54, 54],
    iconAnchor: [27, 27],
    popupAnchor: [0, -24],
    html: `
      <span class="bus-vehicle-icon" style="--route-color:${color}; --heading:${rotationDeg}deg;">
        <span class="bus-vehicle-icon__direction">
          <span class="bus-vehicle-icon__shaft"></span>
          <span class="bus-vehicle-icon__arrow"></span>
        </span>
        <span class="bus-vehicle-icon__body">🚌</span>
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
      ◎
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

    map.fitBounds(bounds, { padding: [40, 40] });
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

  useEffect(() => {
    if (!signal || !userLocation) {
      return;
    }

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

  useEffect(() => {
    if (!signal || !userLocation) {
      return;
    }

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

function dedupeStops(routes: RouteShape[]) {
  const seen = new Map<string, StopMarkerData>();

  routes.forEach((route) => {
    route.stops.forEach((stop) => {
      const existing = seen.get(stop.id);

      if (existing) {
        if (!existing.colors.includes(route.colorHint)) {
          existing.colors.push(route.colorHint);
        }
        return;
      }

      seen.set(stop.id, {
        ...stop,
        colors: [route.colorHint],
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
    });
  });

  return [...merged.values()];
}

function getHeadingDegrees(vehicle: VehiclePosition, route: RouteShape | undefined) {
  if (!route || route.path.length < 2) {
    return vehicle.headingDegrees ?? 0;
  }

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  route.path.forEach((point, index) => {
    const distance = Math.hypot(point.lat - vehicle.lat, point.lng - vehicle.lng);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  const current = route.path[nearestIndex];
  const target =
    route.path[nearestIndex + 1] ??
    route.path[nearestIndex - 1] ??
    route.path[nearestIndex];

  const dx = target.lng - current.lng;
  const dy = target.lat - current.lat;

  return (Math.atan2(dy, dx) * 180) / Math.PI;
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
}: BusMapProps) {
  const stops = useMemo(
    () => mergeNearbyStops(dedupeStops(routes), nearbyStops),
    [nearbyStops, routes],
  );
  const routesById = useMemo(
    () => new Map(routes.map((route) => [route.routeId, route])),
    [routes],
  );

  return (
    <div className="map-shell">
      <MapContainer
        center={[provider.center.lat, provider.center.lng]}
        zoom={provider.zoom}
        minZoom={provider.minZoom}
        maxZoom={provider.maxZoom}
        zoomControl
        className="leaflet-map"
      >
        <OpenFreeMapLayer provider={provider} />
        <FitToRoutes routes={routes} />
        <FocusUserLocation
          userLocation={userLocation}
          signal={focusUserLocationSignal}
        />
        <FocusNearbyStops
          userLocation={userLocation}
          nearbyStops={nearbyStops}
          signal={focusNearbyStopsSignal}
        />
        <RecenterControl
          userLocation={userLocation}
          geolocationStatus={geolocationStatus}
          onRequestUserLocation={onRequestUserLocation}
        />

        <Pane name="routes" style={{ zIndex: 410 }}>
          {routes.map((route) => (
            <Polyline
              key={route.routeId}
              positions={route.path.map((point) => [point.lat, point.lng] as LatLngExpression)}
              pathOptions={{
                color: route.colorHint,
                weight: 6,
                opacity: 0.95,
              }}
            />
          ))}
        </Pane>

        <Pane name="stops" style={{ zIndex: 650 }}>
          {stops.map((stop) => (
            <Marker
              key={stop.id}
              position={[stop.lat, stop.lng]}
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
          {vehicles.map((vehicle) => (
            <Marker
              key={vehicle.vehicleId}
              position={[vehicle.lat, vehicle.lng]}
              icon={createBusIcon(
                routesById.get(vehicle.routeId ?? "")?.colorHint ?? "#dc2626",
                getHeadingDegrees(vehicle, routesById.get(vehicle.routeId ?? "")),
              )}
            />
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
        <span>Proveedor base: {provider.name}</span>
        <span>Paradas: {stops.length}</span>
        <span>Vehiculos activos: {vehicles.length}</span>
        <span>Llegadas visibles: {selectedStopDetails?.arrivals.length ?? 0}</span>
      </div>
    </div>
  );
}
