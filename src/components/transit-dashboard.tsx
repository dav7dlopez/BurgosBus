"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import type {
  Line,
  LineDetail,
  Stop,
  StopArrivalsResponse,
  UserLocation,
  VehiclePosition,
} from "@/lib/types";

const REALTIME_POLL_MS = 10000;

const BusMap = dynamic(
  () => import("@/components/bus-map").then((module) => module.BusMap),
  {
    ssr: false,
    loading: () => (
      <div className="fallback-panel">
        <h2>Cargando mapa</h2>
        <p>Inicializando Leaflet y la capa base de OpenFreeMap.</p>
      </div>
    ),
  },
);

export function TransitDashboard() {
  const [lines, setLines] = useState<Line[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [lineDetail, setLineDetail] = useState<LineDetail | null>(null);
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [stopPanel, setStopPanel] = useState<StopArrivalsResponse | null>(null);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [lineError, setLineError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadLines() {
      setLoading(true);
      try {
        const response = await fetch("/api/lines");
        if (!response.ok) {
          throw new Error("No se pudieron cargar las lineas.");
        }
        const data = (await response.json()) as Line[];
        if (!isMounted) {
          return;
        }
        setLines(data);
        if (data.length > 0) {
          setSelectedLineId(data[0].id);
        }
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setLineError(error instanceof Error ? error.message : "Error desconocido.");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadLines();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        setUserLocation(null);
      },
      {
        enableHighAccuracy: true,
        maximumAge: REALTIME_POLL_MS,
        timeout: 10000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  useEffect(() => {
    if (!selectedLineId) {
      return;
    }

    let active = true;

    async function loadLineSnapshot() {
      setLineError(null);
      try {
        const [lineResponse, vehiclesResponse] = await Promise.all([
          fetch(`/api/lines/${selectedLineId}`),
          fetch(`/api/lines/${selectedLineId}/vehicles`),
        ]);

        if (!lineResponse.ok || !vehiclesResponse.ok) {
          throw new Error("No se pudieron cargar los datos de la linea.");
        }

        const [lineData, vehiclesData] = await Promise.all([
          lineResponse.json() as Promise<LineDetail>,
          vehiclesResponse.json() as Promise<{ vehicles: VehiclePosition[] }>,
        ]);

        if (!active) {
          return;
        }

        setLineDetail(lineData);
        setVehicles(vehiclesData.vehicles);
        setSelectedStop(null);
        setStopPanel(null);
      } catch (error) {
        if (!active) {
          return;
        }
        setLineError(error instanceof Error ? error.message : "Error desconocido.");
      }
    }

    void loadLineSnapshot();

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/lines/${selectedLineId}/vehicles`);
        if (!response.ok) {
          throw new Error("No se pudieron refrescar los vehiculos.");
        }

        const data = (await response.json()) as { vehicles: VehiclePosition[] };
        if (active) {
          setVehicles(data.vehicles);
        }
      } catch (error) {
        if (active) {
          setLineError(
            error instanceof Error ? error.message : "Error refrescando vehiculos.",
          );
        }
      }
    }, REALTIME_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedLineId]);

  useEffect(() => {
    if (!selectedStop) {
      return;
    }

    let active = true;
    const stopId = selectedStop.id;

    async function loadArrivals() {
      setStopError(null);
      try {
        const response = await fetch(`/api/stops/${stopId}/arrivals`);
        if (!response.ok) {
          throw new Error("No se pudieron cargar las llegadas de la parada.");
        }

        const data = (await response.json()) as StopArrivalsResponse;
        if (active) {
          setStopPanel(data);
        }
      } catch (error) {
        if (active) {
          setStopError(error instanceof Error ? error.message : "Error desconocido.");
        }
      }
    }

    void loadArrivals();

    const intervalId = window.setInterval(() => {
      void loadArrivals();
    }, REALTIME_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedStop]);

  const routes = useMemo(() => lineDetail?.routes ?? [], [lineDetail]);
  const routeSummaries = useMemo(
    () =>
      routes.map((route) => ({
        id: route.routeId,
        label: route.directionLabel,
        color: route.colorHint,
      })),
    [routes],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <p className="eyebrow">Tiempo real</p>
          <h1>Autobuses Burgos</h1>
        </div>

        <div className="topbar-controls">
          <label className="field field--compact">
            <span>Linea activa</span>
            <select
              value={selectedLineId}
              onChange={(event) => setSelectedLineId(event.target.value)}
              disabled={loading || lines.length === 0}
            >
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.publicCode} {line.displayName}
                </option>
              ))}
            </select>
          </label>

          {lineDetail ? (
            <div className="line-summary line-summary--hero">
              <span>{lineDetail.publicCode}</span>
              <strong>{lineDetail.displayName}</strong>
            </div>
          ) : null}

        </div>
      </header>

      {lineError ? <p className="error-banner">{lineError}</p> : null}

      <section className="map-stage">
        <div className="map-overlay map-overlay--top">
          {routeSummaries.map((route) => (
            <span key={route.id} className="route-pill">
              <span
                className="route-pill__swatch"
                style={{ backgroundColor: route.color }}
              />
              {route.label}
            </span>
          ))}
        </div>

        <div className="map-overlay map-overlay--bottom">
          {selectedStop ? (
            <div className="stop-card">
              <div className="stop-card__header">
                <strong>{selectedStop.name}</strong>
                <span>#{selectedStop.id}</span>
              </div>
              {stopError ? <p className="error-text">{stopError}</p> : null}
              {stopPanel ? (
                <>
                  <p className="meta">
                    Lineas:{" "}
                    {stopPanel.lines.map((line) => line.publicCode).join(", ") ||
                      "sin dato"}
                  </p>
                  <ul className="arrival-inline-list">
                    {stopPanel.arrivals.slice(0, 4).map((arrival) => (
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
                </>
              ) : (
                <p className="meta">Cargando tiempos...</p>
              )}
            </div>
          ) : (
            <div className="stop-card stop-card--hint">
              Pulsa una parada para ver tiempos de llegada.
            </div>
          )}
        </div>

        <div className="map-panel map-panel--fullscreen">
          <BusMap
            routes={routes}
            selectedStopId={selectedStop?.id ?? null}
            selectedStopDetails={stopPanel}
            onStopSelect={setSelectedStop}
            vehicles={vehicles}
            highlightedLineId={selectedLineId || null}
            userLocation={userLocation}
          />
        </div>
      </section>
    </main>
  );
}

function formatEta(seconds: number) {
  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  if (remainder === 0) {
    return `${minutes} min`;
  }

  return `${minutes} min ${remainder}s`;
}
