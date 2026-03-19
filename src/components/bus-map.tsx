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
  Popup,
  useMap,
} from "react-leaflet";

import { defaultMapProvider, type VectorStyleMapProvider } from "@/lib/map-config";
import type {
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
};

type StopMarkerData = Stop & {
  colors: string[];
};

function createStopIcon(colors: string[], isSelected: boolean): DivIcon {
  const gradient =
    colors.length > 1
      ? `conic-gradient(${colors.join(",")})`
      : colors[0] ?? "#0f766e";

  return divIcon({
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -16],
    html: `
      <span class="bus-stop-icon${isSelected ? " is-selected" : ""}" style="--stop-fill:${gradient}">
        <span class="bus-stop-icon__pole"></span>
      </span>
    `,
  });
}

function createBusIcon(color: string, rotationDeg: number): DivIcon {
  return divIcon({
    className: "",
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -18],
    html: `
      <span class="bus-vehicle-icon" style="--route-color:${color}; --heading:${rotationDeg}deg;">
        <span class="bus-vehicle-icon__body">🚌</span>
        <span class="bus-vehicle-icon__arrow"></span>
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

function formatEta(seconds: number) {
  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder}s`;
}

function StopPopup({
  stop,
  selectedStopDetails,
}: {
  stop: Stop;
  selectedStopDetails: StopArrivalsResponse | null;
}) {
  const arrivals =
    selectedStopDetails?.stop.id === stop.id
      ? selectedStopDetails.arrivals.slice(0, 4)
      : [];

  return (
    <div className="stop-popup">
      <strong>{stop.name}</strong>
      <div className="stop-popup__meta">Parada #{stop.id}</div>
      {arrivals.length === 0 ? (
        <p>Pulsa la parada para cargar tiempos en el panel lateral.</p>
      ) : (
        <ul className="stop-popup__arrivals">
          {arrivals.map((arrival) => (
            <li
              key={`${arrival.lineId}-${arrival.destination}-${arrival.vehicleId}-${arrival.etaSeconds}`}
            >
              <span>
                L{arrival.lineId} {arrival.destination}
              </span>
              <strong>{formatEta(arrival.etaSeconds)}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BusMap({
  routes,
  vehicles,
  selectedStopId,
  selectedStopDetails,
  onStopSelect,
  provider = defaultMapProvider,
  userLocation,
}: BusMapProps) {
  const stops = useMemo(() => dedupeStops(routes), [routes]);
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
              icon={createStopIcon(stop.colors, stop.id === selectedStopId)}
              eventHandlers={{
                click: () => onStopSelect(stop),
              }}
            >
              <Popup>
                <StopPopup stop={stop} selectedStopDetails={selectedStopDetails} />
              </Popup>
            </Marker>
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
            >
              <Popup>
                <div className="stop-popup">
                  <strong>Bus {vehicle.vehicleId}</strong>
                  <div className="stop-popup__meta">
                    Ruta {vehicle.routeId ?? "sin dato"}
                  </div>
                  <p>Posicion actual del vehiculo en servicio.</p>
                </div>
              </Popup>
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
            >
              <Popup>
                <div className="stop-popup">
                  <strong>Tu ubicacion</strong>
                  <p>Posicion obtenida desde el navegador.</p>
                </div>
              </Popup>
            </Marker>
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
