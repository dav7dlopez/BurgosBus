"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { mapProviders } from "@/lib/map-config";
import type {
  GeolocationStatus,
  Line,
  LineDetail,
  NearbyStop,
  NearbyStopsResponse,
  Stop,
  StopArrivalsResponse,
  UserLocation,
  VehiclePosition,
} from "@/lib/types";

const REALTIME_POLL_MS = 10000;
const THEME_STORAGE_KEY = "bus-burgos-theme";
const NEARBY_STOP_RADIUS_METERS = 1000;

const BusMap = dynamic(
  () => import("@/components/bus-map").then((module) => module.BusMap),
  {
    ssr: false,
    loading: () => (
      <div className="fallback-panel fallback-panel--loading">
        <span className="fallback-panel__eyebrow">Mapa en directo</span>
        <h2>Preparando el mapa</h2>
        <p>Cargando la base cartografica y los controles interactivos.</p>
        <div className="stop-card__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    ),
  },
);

export function TransitDashboard() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [nearbyModeEnabled, setNearbyModeEnabled] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [lineDetail, setLineDetail] = useState<LineDetail | null>(null);
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [stopPanel, setStopPanel] = useState<StopArrivalsResponse | null>(null);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [nearbyStops, setNearbyStops] = useState<NearbyStop[]>([]);
  const [nearbyStopsLoading, setNearbyStopsLoading] = useState(false);
  const [nearbyStopsResolved, setNearbyStopsResolved] = useState(false);
  const [focusUserLocationSignal, setFocusUserLocationSignal] = useState(0);
  const [focusNearbyStopsSignal, setFocusNearbyStopsSignal] = useState(0);
  const [geolocationStatus, setGeolocationStatus] =
    useState<GeolocationStatus>("idle");
  const [loading, setLoading] = useState(true);
  const [lineError, setLineError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const geolocationWatchId = useRef<number | null>(null);
  const preserveSelectedStopRef = useRef<Stop | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
      document.documentElement.dataset.theme = savedTheme;
      return;
    }

    document.documentElement.dataset.theme = "light";
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

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

  const requestUserLocation = useMemo(
    () => () => {
      if (typeof window === "undefined") {
        return undefined;
      }

      if (!window.isSecureContext) {
        setGeolocationStatus("insecure");
        return undefined;
      }

      if (!navigator.geolocation) {
        setGeolocationStatus("unsupported");
        return undefined;
      }

      setGeolocationStatus("requesting");

      const startWatching = () => {
        if (geolocationWatchId.current != null) {
          navigator.geolocation.clearWatch(geolocationWatchId.current);
        }

        geolocationWatchId.current = navigator.geolocation.watchPosition(
          (position) => {
            setUserLocation({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracy: position.coords.accuracy,
            });
            setGeolocationStatus("ready");
          },
          (error) => {
            if (error.code === error.PERMISSION_DENIED) {
              setGeolocationStatus("denied");
            } else {
              setGeolocationStatus("error");
            }
          },
          {
            enableHighAccuracy: true,
            maximumAge: REALTIME_POLL_MS,
            timeout: 10000,
          },
        );
      };

      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
          setGeolocationStatus("ready");
          startWatching();
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            setGeolocationStatus("denied");
          } else {
            setGeolocationStatus("error");
          }
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000,
        },
      );

      return geolocationWatchId.current ?? undefined;
    },
    [],
  );

  useEffect(() => {
    if (!locationEnabled) {
      if (geolocationWatchId.current != null) {
        navigator.geolocation.clearWatch(geolocationWatchId.current);
        geolocationWatchId.current = null;
      }
      setUserLocation(null);
      setGeolocationStatus("idle");
      return;
    }

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setGeolocationStatus("insecure");
      return;
    }

    if (!navigator.geolocation) {
      setGeolocationStatus("unsupported");
      return;
    }

    const watchId = requestUserLocation();

    return () => {
      if (typeof watchId === "number") {
        navigator.geolocation.clearWatch(watchId);
      }
      if (geolocationWatchId.current != null) {
        navigator.geolocation.clearWatch(geolocationWatchId.current);
        geolocationWatchId.current = null;
      }
    };
  }, [locationEnabled, requestUserLocation]);

  useEffect(() => {
    if (!nearbyModeEnabled || !userLocation) {
      setNearbyStops([]);
      setNearbyStopsLoading(false);
      setNearbyStopsResolved(false);
      return;
    }

    let active = true;
    const currentLocation = userLocation;

    async function loadNearbyStops() {
      if (active) {
        setNearbyStopsLoading(true);
      }

      try {
        const params = new URLSearchParams({
          lat: String(currentLocation.lat),
          lng: String(currentLocation.lng),
          radius: String(NEARBY_STOP_RADIUS_METERS),
        });
        const response = await fetch(`/api/stops/nearby?${params.toString()}`);
        if (!response.ok) {
          throw new Error("No se pudieron cargar las paradas cercanas.");
        }

        const data = (await response.json()) as NearbyStopsResponse;
        if (active) {
          setNearbyStops(data.stops);
          setNearbyStopsResolved(true);
        }
      } catch (error) {
        if (active) {
          setLineError(
            error instanceof Error ? error.message : "Error cargando paradas cercanas.",
          );
          setNearbyStopsResolved(true);
        }
      } finally {
        if (active) {
          setNearbyStopsLoading(false);
        }
      }
    }

    void loadNearbyStops();

    const intervalId = window.setInterval(() => {
      void loadNearbyStops();
    }, REALTIME_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [nearbyModeEnabled, userLocation]);

  useEffect(() => {
    if (!selectedLineId) {
      return;
    }

    let active = true;

    async function loadLineSnapshot() {
      setLineError(null);
      const stopToPreserve = preserveSelectedStopRef.current;
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
        if (stopToPreserve) {
          const stopStillBelongsToLine = lineData.routes.some((route) =>
            route.stops.some((stop) => stop.id === stopToPreserve.id),
          );

          if (stopStillBelongsToLine) {
            setSelectedStop(stopToPreserve);
          } else {
            setSelectedStop(null);
            setStopPanel(null);
          }
        } else {
          setSelectedStop(null);
          setStopPanel(null);
        }
      } catch (error) {
        if (!active) {
          return;
        }
        setLineError(error instanceof Error ? error.message : "Error desconocido.");
      } finally {
        preserveSelectedStopRef.current = null;
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
  const activeMapProvider =
    theme === "dark" ? mapProviders.openFreeMapDark : mapProviders.openFreeMap;
  const routeSummaries = useMemo(
    () =>
      routes.map((route) => ({
        id: route.routeId,
        label: route.directionLabel,
        color: route.colorHint,
      })),
    [routes],
  );
  const selectedStopLineCodes = stopPanel?.lines.map((line) => line.publicCode).join(", ");
  const nearbyStopIds = useMemo(
    () => new Set(nearbyStops.map((item) => item.stop.id)),
    [nearbyStops],
  );

  function activateLineFromStop(lineId: string) {
    if (!selectedStop || lineId === selectedLineId) {
      return;
    }

    preserveSelectedStopRef.current = selectedStop;
    setSelectedLineId(lineId);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-head">
          <div className="brand-lockup">
            <p className="eyebrow">Tiempo real</p>
            <h1>Autobuses Burgos</h1>
          </div>

          <div className="theme-toggle" aria-label="Selector de tema">
            <button
              type="button"
              className={`theme-toggle__button${theme === "light" ? " is-active" : ""}`}
              aria-label="Activar modo claro"
              title="Modo claro"
              onClick={() => setTheme("light")}
            >
              Claro
            </button>
            <button
              type="button"
              className={`theme-toggle__button${theme === "dark" ? " is-active" : ""}`}
              aria-label="Activar modo oscuro"
              title="Modo oscuro"
              onClick={() => setTheme("dark")}
            >
              Oscuro
            </button>
            <button
              type="button"
              className={`theme-toggle__button theme-toggle__button--gps${locationEnabled ? " is-active" : " is-off"}`}
              aria-label={
                locationEnabled ? "Desactivar ubicacion" : "Activar ubicacion"
              }
              title={locationEnabled ? "Ubicacion activada" : "Activar ubicacion"}
              onClick={() => {
                setLocationEnabled((current) => !current);
                setFocusUserLocationSignal((current) => current + 1);
              }}
            >
              GPS
            </button>
            <button
              type="button"
              className={`theme-toggle__button theme-toggle__button--nearby${nearbyModeEnabled ? " is-active" : ""}`}
              aria-label={
                nearbyModeEnabled
                  ? "Ocultar paradas cercanas"
                  : "Mostrar paradas cercanas"
              }
              title={
                nearbyModeEnabled
                  ? "Ocultar paradas cercanas"
                  : "Mostrar paradas cercanas"
              }
              onClick={() => {
                setLocationEnabled(true);
                setNearbyModeEnabled((current) => !current);
                setFocusNearbyStopsSignal((current) => current + 1);
              }}
            >
              Cercanas
            </button>
          </div>
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
        </div>
      </header>

      {lineError ? <p className="error-banner">{lineError}</p> : null}

      <section className="map-stage">
        <div className="map-overlay map-overlay--top">
          <button
            type="button"
            className={`legend-toggle${isMobileLegendOpen ? " is-open" : ""}`}
            onClick={() => setIsMobileLegendOpen((current) => !current)}
            aria-expanded={isMobileLegendOpen}
            aria-controls="route-legend"
          >
            Recorridos
          </button>
          <div
            id="route-legend"
            className={`route-legend${isMobileLegendOpen ? " is-open" : ""}`}
          >
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
        </div>

        <div className="map-overlay map-overlay--bottom">
          {geolocationStatus === "insecure" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="Activa HTTPS para usar tu posicion"
              description="La ubicacion del navegador solo funciona en un contexto seguro y con permisos del sitio."
            />
          ) : geolocationStatus === "denied" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="No hay acceso a tu ubicacion"
              description="Puedes volver a activarla con el boton GPS o revisar los permisos del navegador para este sitio."
            />
          ) : geolocationStatus === "unsupported" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="Este navegador no ofrece geolocalizacion"
              description="La app seguira funcionando con el mapa y las lineas, pero sin funciones basadas en tu posicion."
            />
          ) : nearbyModeEnabled && nearbyStops.length > 0 && !selectedStop ? (
            <StatusCard
              eyebrow="Paradas cercanas"
              title={`${nearbyStops.length} paradas disponibles a tu alrededor`}
              description="Pulsa cualquiera en el mapa para consultar sus lineas activas y los proximos tiempos de paso."
            />
          ) : nearbyModeEnabled && nearbyStopsLoading && !selectedStop ? (
            <StatusCard
              eyebrow="Paradas cercanas"
              title="Buscando paradas cerca de ti"
              description="Estamos consultando las paradas disponibles alrededor de tu ubicacion."
              tone="loading"
            >
              <div className="stop-card__skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </StatusCard>
          ) : nearbyModeEnabled && nearbyStopsResolved && userLocation && !selectedStop ? (
            <StatusCard
              eyebrow="Paradas cercanas"
              title="No hay paradas en este radio"
              description="No hemos encontrado paradas urbanas en 1 km alrededor de tu ubicacion actual."
            />
          ) : selectedStop ? (
            <div className="stop-card">
              <div className="stop-card__header">
                <strong>{selectedStop.name}</strong>
                <div className="stop-card__actions">
                  <span>#{selectedStop.id}</span>
                  <button
                    type="button"
                    className="stop-card__close"
                    onClick={() => {
                      setSelectedStop(null);
                      setStopPanel(null);
                      setStopError(null);
                    }}
                    aria-label="Cerrar informacion de parada"
                  >
                    ×
                  </button>
                </div>
              </div>
              {stopError ? (
                <div className="stop-card__message stop-card__message--error">
                  <strong>No hemos podido actualizar esta parada</strong>
                  <p>{stopError}</p>
                </div>
              ) : null}
              {stopPanel ? (
                <>
                  <p className="meta">
                    Líneas: {selectedStopLineCodes || "sin información"}
                  </p>
                  {stopPanel.arrivals.length > 0 ? (
                    <ul className="arrival-inline-list">
                      {stopPanel.arrivals.slice(0, 4).map((arrival, index) => (
                        <li
                          key={`${arrival.lineId}-${arrival.destination}-${arrival.vehicleId ?? "na"}-${arrival.etaSeconds}-${index}`}
                        >
                          <button
                            type="button"
                            className={`arrival-inline-button${
                              arrival.lineId === selectedLineId ? " is-active" : ""
                            }`}
                            onClick={() => activateLineFromStop(arrival.lineId)}
                          >
                            <span>
                              Línea {arrival.lineId} · {arrival.destination}
                            </span>
                            <strong>{formatEta(arrival.etaSeconds)}</strong>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="stop-card__message stop-card__message--empty">
                      <strong>No hay llegadas visibles ahora mismo</strong>
                      <p>
                        La parada no muestra tiempos en este momento. Prueba de nuevo
                        en unos segundos o cambia de linea activa.
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="stop-card__message stop-card__message--loading">
                  <strong>Cargando tiempos de llegada</strong>
                  <p>Consultando la informacion en tiempo real de esta parada.</p>
                  <div className="stop-card__skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <StatusCard
              eyebrow="Detalle de parada"
              title="Selecciona una parada"
              description="Pulsa una parada del mapa para ver sus lineas activas y los proximos tiempos de paso."
            />
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
            geolocationStatus={geolocationStatus}
            nearbyStops={nearbyStops.map((item) => item.stop)}
            nearbyStopIds={nearbyStopIds}
            focusUserLocationSignal={focusUserLocationSignal}
            focusNearbyStopsSignal={focusNearbyStopsSignal}
            onRequestUserLocation={() => {
              setLocationEnabled(true);
              setFocusUserLocationSignal((current) => current + 1);
              requestUserLocation();
            }}
            provider={activeMapProvider}
          />
        </div>
      </section>
    </main>
  );
}

type StatusCardProps = {
  description: string;
  eyebrow?: string;
  title: string;
  tone?: "neutral" | "loading";
  children?: ReactNode;
};

function StatusCard({
  description,
  eyebrow,
  title,
  tone = "neutral",
  children,
}: StatusCardProps) {
  return (
    <div className={`stop-card stop-card--hint stop-card--state stop-card--${tone}`}>
      {eyebrow ? <span className="stop-card__eyebrow">{eyebrow}</span> : null}
      <strong className="stop-card__title">{title}</strong>
      <p className="stop-card__description">{description}</p>
      {children}
    </div>
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
