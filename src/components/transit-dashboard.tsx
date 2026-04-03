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
const LAST_SELECTED_LINE_STORAGE_KEY = "bus-burgos-last-selected-line";
const FAVORITE_LINES_STORAGE_KEY = "bus-burgos-favorite-lines";
const FAVORITE_STOPS_STORAGE_KEY = "bus-burgos-favorite-stops";
const NEARBY_STOP_RADIUS_METERS = 1000;

type FavoriteStop = {
  id: string;
  name: string;
  lineId?: string | null;
};

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

function getRouteRenderKey(route: LineDetail["routes"][number]) {
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

export function TransitDashboard() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [favoriteStopsPanelOpen, setFavoriteStopsPanelOpen] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [nearbyModeEnabled, setNearbyModeEnabled] = useState(false);
  const [isNearbyPanelMinimized, setIsNearbyPanelMinimized] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [favoriteLineIds, setFavoriteLineIds] = useState<string[]>([]);
  const [favoriteStops, setFavoriteStops] = useState<FavoriteStop[]>([]);
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
  const lastSelectedLineIdRef = useRef<string | null>(null);
  const preserveSelectedStopRef = useRef<Stop | null>(null);
  const pendingFavoriteStopIdRef = useRef<string | null>(null);

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

    const savedLineId = window.localStorage.getItem(LAST_SELECTED_LINE_STORAGE_KEY);
    if (savedLineId) {
      lastSelectedLineIdRef.current = savedLineId;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedLineId) {
      return;
    }

    window.localStorage.setItem(LAST_SELECTED_LINE_STORAGE_KEY, selectedLineId);
  }, [selectedLineId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const savedFavorites = window.localStorage.getItem(FAVORITE_LINES_STORAGE_KEY);
      if (!savedFavorites) {
        return;
      }

      const parsedFavorites = JSON.parse(savedFavorites);
      if (Array.isArray(parsedFavorites)) {
        setFavoriteLineIds(
          parsedFavorites.filter((value): value is string => typeof value === "string"),
        );
      }
    } catch {
      window.localStorage.removeItem(FAVORITE_LINES_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const savedFavoriteStops = window.localStorage.getItem(
        FAVORITE_STOPS_STORAGE_KEY,
      );
      if (!savedFavoriteStops) {
        return;
      }

      const parsedFavoriteStops = JSON.parse(savedFavoriteStops);
      if (Array.isArray(parsedFavoriteStops)) {
        setFavoriteStops(
          parsedFavoriteStops.filter(
            (value): value is FavoriteStop =>
              typeof value === "object" &&
              value !== null &&
              typeof value.id === "string" &&
              typeof value.name === "string" &&
              (typeof value.lineId === "string" ||
                value.lineId === null ||
                value.lineId === undefined),
          ),
        );
      }
    } catch {
      window.localStorage.removeItem(FAVORITE_STOPS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      FAVORITE_LINES_STORAGE_KEY,
      JSON.stringify(favoriteLineIds),
    );
  }, [favoriteLineIds]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      FAVORITE_STOPS_STORAGE_KEY,
      JSON.stringify(favoriteStops),
    );
  }, [favoriteStops]);

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
          const savedLineId = lastSelectedLineIdRef.current;
          const restoredLineId = savedLineId
            ? data.find((line) => line.id === savedLineId)?.id
            : null;

          setSelectedLineId(restoredLineId ?? data[0].id);
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
    if (!nearbyModeEnabled) {
      setIsNearbyPanelMinimized(false);
    }
  }, [nearbyModeEnabled]);

  useEffect(() => {
    if (!selectedLineId) {
      return;
    }

    let active = true;

    async function loadLineSnapshot() {
      setLineError(null);
      const stopToPreserve = preserveSelectedStopRef.current;
      const pendingFavoriteStopId = pendingFavoriteStopIdRef.current;
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
        if (pendingFavoriteStopId) {
          const favoriteStop = lineData.routes
            .flatMap((route) => route.stops)
            .find((stop) => stop.id === pendingFavoriteStopId);

          if (favoriteStop) {
            setSelectedStop(favoriteStop);
            setStopPanel(null);
          } else {
            setSelectedStop(null);
            setStopPanel(null);
          }
        } else if (stopToPreserve) {
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
        pendingFavoriteStopIdRef.current = null;
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
      routes.map((route, index) => ({
        id: route.routeId,
        renderKey: `${getRouteRenderKey(route)}|${index}`,
        label: route.directionLabel,
        color: route.colorHint,
      })),
    [routes],
  );
  const selectedStopLineCodes = stopPanel?.lines.map((line) => line.publicCode).join(", ");
  const favoriteLines = useMemo(
    () => lines.filter((line) => favoriteLineIds.includes(line.id)),
    [favoriteLineIds, lines],
  );
  const isSelectedLineFavorite = favoriteLineIds.includes(selectedLineId);
  const isSelectedStopFavorite = selectedStop
    ? favoriteStops.some((stop) => stop.id === selectedStop.id)
    : false;
  const nearbyStopIds = useMemo(
    () => new Set(nearbyStops.map((item) => item.stop.id)),
    [nearbyStops],
  );

  useEffect(() => {
    if (lines.length === 0) {
      return;
    }

    setFavoriteLineIds((current) =>
      current.filter((lineId) => lines.some((line) => line.id === lineId)),
    );
  }, [lines]);

  function activateLineFromStop(lineId: string) {
    if (!selectedStop || lineId === selectedLineId) {
      return;
    }

    preserveSelectedStopRef.current = selectedStop;
    setSelectedLineId(lineId);
  }

  function toggleFavoriteLine(lineId: string) {
    setFavoriteLineIds((current) =>
      current.includes(lineId)
        ? current.filter((favoriteId) => favoriteId !== lineId)
        : [...current, lineId],
    );
  }

  function toggleFavoriteStop(stop: Stop) {
    setFavoriteStops((current) =>
      current.some((favoriteStop) => favoriteStop.id === stop.id)
        ? current.filter((favoriteStop) => favoriteStop.id !== stop.id)
        : [...current, { id: stop.id, name: stop.name, lineId: selectedLineId || null }],
    );
  }

  function reopenFavoriteStop(favoriteStop: FavoriteStop) {
    if (selectedStop?.id === favoriteStop.id) {
      return;
    }

    const currentLineStop = routes
      .flatMap((route) => route.stops)
      .find((stop) => stop.id === favoriteStop.id);

    if (currentLineStop) {
      setSelectedStop(currentLineStop);
      setStopPanel(null);
      setStopError(null);
      return;
    }

    if (favoriteStop.lineId && favoriteStop.lineId !== selectedLineId) {
      pendingFavoriteStopIdRef.current = favoriteStop.id;
      setSelectedStop(null);
      setStopPanel(null);
      setStopError(null);
      setSelectedLineId(favoriteStop.lineId);
    }
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
            <button
              type="button"
              className={`theme-toggle__button theme-toggle__button--favorites${
                favoriteStopsPanelOpen ? " is-active" : ""
              }`}
              aria-label={
                favoriteStopsPanelOpen
                  ? "Ocultar paradas favoritas"
                  : "Mostrar paradas favoritas"
              }
              aria-expanded={favoriteStopsPanelOpen}
              aria-controls="favorite-stops-panel"
              title={
                favoriteStopsPanelOpen
                  ? "Ocultar paradas favoritas"
                  : "Mostrar paradas favoritas"
              }
              onClick={() => setFavoriteStopsPanelOpen((current) => !current)}
            >
              Favoritas
            </button>
          </div>
        </div>

        <div className="topbar-controls">
          <div className="line-picker">
            <div className="line-picker__row">
              <label className="field field--compact">
                <span>Linea activa</span>
                <select
                  value={selectedLineId}
                  onChange={(event) => setSelectedLineId(event.target.value)}
                  disabled={loading || lines.length === 0}
                >
                  {lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {favoriteLineIds.includes(line.id) ? "★ " : ""}
                      {line.publicCode} {line.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`favorite-toggle${isSelectedLineFavorite ? " is-active" : ""}`}
                onClick={() => toggleFavoriteLine(selectedLineId)}
                disabled={!selectedLineId}
                aria-pressed={isSelectedLineFavorite}
                aria-label={
                  isSelectedLineFavorite
                    ? "Quitar linea de favoritas"
                    : "Marcar linea como favorita"
                }
                title={
                  isSelectedLineFavorite
                    ? "Quitar de favoritas"
                    : "Guardar en favoritas"
                }
              >
                <span className="favorite-toggle__icon" aria-hidden="true">
                  ★
                </span>
                <span className="favorite-toggle__label">
                  {isSelectedLineFavorite ? "Favorita" : "Guardar"}
                </span>
              </button>
            </div>

            {favoriteLines.length > 0 ? (
              <div className="favorite-strip" aria-label="Lineas favoritas">
                <span className="favorite-strip__label">Favoritas</span>
                <div className="favorite-strip__scroller">
                  {favoriteLines.map((line) => (
                    <button
                      key={line.id}
                      type="button"
                      className={`favorite-line-chip${
                        line.id === selectedLineId ? " is-active" : ""
                      }`}
                      onClick={() => setSelectedLineId(line.id)}
                    >
                      <span className="favorite-line-chip__icon" aria-hidden="true">
                        ★
                      </span>
                      {line.publicCode}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {favoriteStopsPanelOpen ? (
          <div
            id="favorite-stops-panel"
            className="favorite-stop-strip favorite-stop-strip--panel"
            aria-label="Paradas favoritas"
          >
            {favoriteStops.length > 0 ? (
              <>
                <span className="favorite-stop-strip__label">Paradas favoritas</span>
                <div className="favorite-stop-strip__scroller">
                  {favoriteStops.map((favoriteStop) => (
                    <button
                      key={favoriteStop.id}
                      type="button"
                      className={`favorite-stop-chip${
                        favoriteStop.id === selectedStop?.id ? " is-active" : ""
                      }`}
                      onClick={() => reopenFavoriteStop(favoriteStop)}
                      title={favoriteStop.name}
                    >
                      <span className="favorite-stop-chip__name">{favoriteStop.name}</span>
                      <span className="favorite-stop-chip__meta">#{favoriteStop.id}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="favorite-stop-empty">
                <strong>No hay paradas favoritas aún</strong>
                <p>Guarda una parada desde su panel para tenerla aquí a mano.</p>
              </div>
            )}
          </div>
        ) : null}
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
              <span key={route.renderKey} className="route-pill">
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
            isNearbyPanelMinimized ? (
              <button
                type="button"
                className="nearby-panel-toggle"
                onClick={() => setIsNearbyPanelMinimized(false)}
                aria-label="Mostrar panel de paradas cercanas"
              >
                <span className="nearby-panel-toggle__icon" aria-hidden="true">
                  ◎
                </span>
                <span className="nearby-panel-toggle__content">
                  <span className="nearby-panel-toggle__eyebrow">Paradas cercanas</span>
                  <span className="nearby-panel-toggle__title">
                    {nearbyStops.length} disponibles
                  </span>
                </span>
              </button>
            ) : (
              <div className="stop-card stop-card--hint stop-card--state">
                <div className="stop-card__header stop-card__header--compact">
                  <div className="stop-card__title-block">
                    <span className="stop-card__eyebrow">Paradas cercanas</span>
                    <strong className="stop-card__title">
                      {nearbyStops.length} paradas disponibles a tu alrededor
                    </strong>
                    <p className="stop-card__description">
                      Consulta la distancia de cada parada y pulsa la que mejor te
                      encaje para ver sus lineas activas y los proximos tiempos de
                      paso.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="stop-card__collapse"
                    onClick={() => setIsNearbyPanelMinimized(true)}
                    aria-label="Minimizar panel de paradas cercanas"
                    title="Minimizar panel"
                  >
                    <span className="stop-card__collapse-icon" aria-hidden="true">
                      −
                    </span>
                    <span className="stop-card__collapse-label">Ocultar</span>
                  </button>
                </div>
                <div className="nearby-stop-list" aria-label="Lista de paradas cercanas">
                  {nearbyStops.slice(0, 4).map((item) => (
                    <button
                      key={item.stop.id}
                      type="button"
                      className="nearby-stop-list__item"
                      onClick={() => {
                        setStopPanel(null);
                        setStopError(null);
                        setSelectedStop(item.stop);
                      }}
                    >
                      <span className="nearby-stop-list__main">
                        <span className="nearby-stop-list__name">{item.stop.name}</span>
                        <span className="nearby-stop-list__distance">
                          {formatDistance(item.distanceMeters)}
                        </span>
                      </span>
                      <span className="nearby-stop-list__meta">
                        {item.lines
                          .slice(0, 3)
                          .map((line) => line.publicCode)
                          .join(" · ")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
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
            <div className="stop-card stop-card--detail">
              <div className="stop-card__header">
                <div className="stop-card__title-block">
                  <span className="stop-card__eyebrow">Parada seleccionada</span>
                  <strong className="stop-card__name">{selectedStop.name}</strong>
                </div>
                <div className="stop-card__actions">
                  <button
                    type="button"
                    className={`favorite-toggle favorite-toggle--panel${
                      isSelectedStopFavorite ? " is-active" : ""
                    }`}
                    onClick={() => toggleFavoriteStop(selectedStop)}
                    aria-pressed={isSelectedStopFavorite}
                    aria-label={
                      isSelectedStopFavorite
                        ? "Quitar parada de favoritas"
                        : "Marcar parada como favorita"
                    }
                    title={
                      isSelectedStopFavorite
                        ? "Quitar parada de favoritas"
                        : "Guardar parada en favoritas"
                    }
                  >
                    <span className="favorite-toggle__icon" aria-hidden="true">
                      ★
                    </span>
                    <span className="favorite-toggle__label">
                      {isSelectedStopFavorite ? "Favorita" : "Guardar"}
                    </span>
                  </button>
                  <span className="stop-card__stop-id">#{selectedStop.id}</span>
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
                  <div className="stop-card__section stop-card__section--meta">
                    <span className="stop-card__section-label">Líneas activas</span>
                    <p className="meta stop-card__meta-text">
                      {selectedStopLineCodes || "Sin informacion disponible"}
                    </p>
                  </div>
                  {stopPanel.arrivals.length > 0 ? (
                    <div className="stop-card__section">
                      <div className="stop-card__section-head">
                        <span className="stop-card__section-label">
                          Proximos tiempos
                        </span>
                        <span className="stop-card__section-caption">
                          Hasta 4 llegadas visibles
                        </span>
                      </div>
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
                    </div>
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

function formatDistance(distanceMeters: number) {
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }

  const kilometers = distanceMeters / 1000;
  return `${kilometers.toFixed(kilometers >= 10 ? 0 : 1)} km`;
}
