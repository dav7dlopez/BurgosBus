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
const DEFAULT_INFO_PANEL_MINIMIZED_STORAGE_KEY =
  "bus-burgos-default-info-panel-minimized";
const NEARBY_STOP_RADIUS_METERS = 1000;

type FavoriteStop = {
  id: string;
  name: string;
  lineId?: string | null;
};

function buildFavoriteStopPlaceholder(favoriteStop: FavoriteStop): Stop {
  return {
    id: favoriteStop.id,
    code: null,
    name: favoriteStop.name,
    lat: 0,
    lng: 0,
    type: null,
    source: "isaenext",
  };
}

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

function getLineOptionLabel(line: Line, isFavorite: boolean) {
  const statusLabel =
    line.isActiveNow === false ? "[Sin servicio ahora]" : "[En servicio]";
  const favoritePrefix = isFavorite ? "★ " : "";

  return `${favoritePrefix}${line.publicCode} ${line.displayName} · ${statusLabel}`;
}

function getVehicleTrackingLabel(vehicleId: string) {
  return vehicleId.length > 10
    ? `Vehículo ${vehicleId.slice(-4)}`
    : `Vehículo ${vehicleId}`;
}

function getDistanceBetweenPoints(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
) {
  return Math.hypot(end.lat - start.lat, end.lng - start.lng);
}

function getProjectedPositionOnSegment(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
) {
  const dx = end.lat - start.lat;
  const dy = end.lng - start.lng;
  const denominator = dx * dx + dy * dy;

  if (denominator === 0) {
    return {
      distance: getDistanceBetweenPoints(point, start),
      progress: 0,
    };
  }

  const projection =
    ((point.lat - start.lat) * dx + (point.lng - start.lng) * dy) / denominator;
  const progress = Math.min(1, Math.max(0, projection));
  const projectedLat = start.lat + dx * progress;
  const projectedLng = start.lng + dy * progress;

  return {
    distance: Math.hypot(point.lat - projectedLat, point.lng - projectedLng),
    progress,
  };
}

function getRouteProgressAtPoint(
  point: { lat: number; lng: number },
  path: Array<{ lat: number; lng: number }>,
) {
  if (path.length < 2) {
    return null;
  }

  const segmentLengths: number[] = [];
  let traversedLength = 0;
  let bestMatch:
    | {
        distance: number;
        absoluteProgress: number;
      }
    | undefined;

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const segmentLength = getDistanceBetweenPoints(start, end);
    segmentLengths.push(segmentLength);

    const projection = getProjectedPositionOnSegment(point, start, end);
    const absoluteProgress = traversedLength + segmentLength * projection.progress;

    if (!bestMatch || projection.distance < bestMatch.distance) {
      bestMatch = {
        distance: projection.distance,
        absoluteProgress,
      };
    }

    traversedLength += segmentLength;
  }

  return bestMatch?.absoluteProgress ?? null;
}

function formatEtaLabel(etaSeconds: number) {
  if (etaSeconds < 60) {
    return "Menos de 1 min";
  }

  const minutes = Math.ceil(etaSeconds / 60);
  return `${minutes} min`;
}

type FollowedVehicleStopState =
  | {
      mode: "real";
      stopId: string;
      stopName: string;
      etaLabel: string;
    }
  | {
      mode: "stop-only";
      stopId: string;
      stopName: string;
      note: string;
    }
  | null;

export function TransitDashboard() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [favoriteStopsPanelOpen, setFavoriteStopsPanelOpen] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [nearbyModeEnabled, setNearbyModeEnabled] = useState(false);
  const [isNearbyPanelMinimized, setIsNearbyPanelMinimized] = useState(false);
  const [isNearbyListExpanded, setIsNearbyListExpanded] = useState(false);
  const [isDefaultInfoPanelMinimized, setIsDefaultInfoPanelMinimized] =
    useState(false);
  const [showActiveLinesOnly, setShowActiveLinesOnly] = useState(false);
  const [isLiveTrackingEnabled, setIsLiveTrackingEnabled] = useState(false);
  const [liveTrackingRouteId, setLiveTrackingRouteId] = useState<string | null>(null);
  const [followedVehicleId, setFollowedVehicleId] = useState<string | null>(null);
  const [vehicleTrackingNotice, setVehicleTrackingNotice] = useState<string | null>(
    null,
  );
  const [followedVehicleStopState, setFollowedVehicleStopState] =
    useState<FollowedVehicleStopState>(null);
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
  const lastVehicleTrackingLineIdRef = useRef<string | null>(null);
  const previousLiveTrackingRouteIdBeforeFollowRef = useRef<
    string | null | undefined
  >(undefined);
  const previousUnfilteredLineIdRef = useRef<string | null>(null);
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

    const savedState = window.localStorage.getItem(
      DEFAULT_INFO_PANEL_MINIMIZED_STORAGE_KEY,
    );

    if (savedState === "true") {
      setIsDefaultInfoPanelMinimized(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      DEFAULT_INFO_PANEL_MINIMIZED_STORAGE_KEY,
      String(isDefaultInfoPanelMinimized),
    );
  }, [isDefaultInfoPanelMinimized]);

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

      if (geolocationWatchId.current != null) {
        return geolocationWatchId.current;
      }

      setGeolocationStatus("requesting");

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
      setIsNearbyListExpanded(false);
    }
  }, [nearbyModeEnabled]);

  useEffect(() => {
    if (!selectedLineId) {
      setLineDetail(null);
      setVehicles([]);
      setSelectedStop(null);
      setStopPanel(null);
      setLineError(null);
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
  const selectedLine = useMemo(
    () => lines.find((line) => line.id === selectedLineId) ?? null,
    [lines, selectedLineId],
  );
  const canFilterLiveTrackingByRoute = useMemo(() => {
    if (routes.length <= 1 || vehicles.length === 0) {
      return false;
    }

    const routeIds = new Set(routes.map((route) => route.routeId));

    return vehicles.every(
      (vehicle) => vehicle.routeId !== null && routeIds.has(vehicle.routeId),
    );
  }, [routes, vehicles]);
  const liveTrackingRouteOptions = useMemo(
    () =>
      canFilterLiveTrackingByRoute
        ? routeSummaries.filter((summary) =>
            vehicles.some((vehicle) => vehicle.routeId === summary.id),
          )
        : [],
    [canFilterLiveTrackingByRoute, routeSummaries, vehicles],
  );
  const visibleLiveTrackingVehicles = useMemo(
    () =>
      isLiveTrackingEnabled && canFilterLiveTrackingByRoute && liveTrackingRouteId
        ? vehicles.filter((vehicle) => vehicle.routeId === liveTrackingRouteId)
        : vehicles,
    [canFilterLiveTrackingByRoute, isLiveTrackingEnabled, liveTrackingRouteId, vehicles],
  );
  const followedVehicle = useMemo(
    () =>
      followedVehicleId
        ? visibleLiveTrackingVehicles.find(
            (vehicle) => vehicle.vehicleId === followedVehicleId,
          ) ?? null
        : null,
    [followedVehicleId, visibleLiveTrackingVehicles],
  );
  const followedVehicleRoute = useMemo(
    () =>
      followedVehicle?.routeId
        ? routes.find((route) => route.routeId === followedVehicle.routeId) ?? null
        : null,
    [followedVehicle, routes],
  );
  const followedVehicleNextStop = useMemo(() => {
    if (!followedVehicle || !followedVehicleRoute || followedVehicleRoute.path.length < 2) {
      return null;
    }

    const vehicleProgress = getRouteProgressAtPoint(
      { lat: followedVehicle.lat, lng: followedVehicle.lng },
      followedVehicleRoute.path,
    );

    if (vehicleProgress === null) {
      return null;
    }

    const orderedStops = [...followedVehicleRoute.stops]
      .sort((a, b) => a.sequence - b.sequence)
      .map((stop) => ({
        stop,
        progress: getRouteProgressAtPoint(
          { lat: stop.lat, lng: stop.lng },
          followedVehicleRoute.path,
        ),
      }))
      .filter(
        (
          item,
        ): item is {
          stop: (typeof followedVehicleRoute.stops)[number];
          progress: number;
        } => item.progress !== null,
      );

    return (
      orderedStops.find((item) => item.progress > vehicleProgress + 0.00005)?.stop ?? null
    );
  }, [followedVehicle, followedVehicleRoute]);
  const visibleLines = useMemo(
    () =>
      showActiveLinesOnly
        ? lines.filter((line) => line.isActiveNow)
        : lines,
    [lines, showActiveLinesOnly],
  );
  const isSelectedLineFavorite = favoriteLineIds.includes(selectedLineId);
  const isSelectedStopFavorite = selectedStop
    ? favoriteStops.some((stop) => stop.id === selectedStop.id)
    : false;
  const nearbyStopIds = useMemo(
    () => new Set(nearbyStops.map((item) => item.stop.id)),
    [nearbyStops],
  );
  const visibleNearbyStops = useMemo(
    () => (isNearbyListExpanded ? nearbyStops : nearbyStops.slice(0, 4)),
    [isNearbyListExpanded, nearbyStops],
  );

  useEffect(() => {
    if (lines.length === 0) {
      return;
    }

    setFavoriteLineIds((current) =>
      current.filter((lineId) => lines.some((line) => line.id === lineId)),
    );
  }, [lines]);

  useEffect(() => {
    if (!selectedLineId) {
      setIsLiveTrackingEnabled(false);
      setLiveTrackingRouteId(null);
      setFollowedVehicleId(null);
      setVehicleTrackingNotice(null);
      setFollowedVehicleStopState(null);
      previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
    }
  }, [selectedLineId]);

  useEffect(() => {
    if (lastVehicleTrackingLineIdRef.current === null) {
      lastVehicleTrackingLineIdRef.current = selectedLineId;
      return;
    }

    if (selectedLineId !== lastVehicleTrackingLineIdRef.current) {
      setFollowedVehicleId(null);
      setVehicleTrackingNotice(null);
      setFollowedVehicleStopState(null);
      previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
    }

    lastVehicleTrackingLineIdRef.current = selectedLineId;
  }, [selectedLineId]);

  useEffect(() => {
    if (isLiveTrackingEnabled) {
      return;
    }

    if (followedVehicleId !== null) {
      setFollowedVehicleId(null);
    }
    if (followedVehicleStopState !== null) {
      setFollowedVehicleStopState(null);
    }
    previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
  }, [followedVehicleId, followedVehicleStopState, isLiveTrackingEnabled]);

  useEffect(() => {
    if (!isLiveTrackingEnabled || !canFilterLiveTrackingByRoute) {
      if (liveTrackingRouteId !== null) {
        setLiveTrackingRouteId(null);
      }
      return;
    }

    if (liveTrackingRouteId === null) {
      return;
    }

    if (liveTrackingRouteOptions.some((route) => route.id === liveTrackingRouteId)) {
      return;
    }

    setLiveTrackingRouteId(null);
  }, [
    canFilterLiveTrackingByRoute,
    isLiveTrackingEnabled,
    liveTrackingRouteId,
    liveTrackingRouteOptions,
  ]);

  useEffect(() => {
    if (!showActiveLinesOnly) {
      return;
    }

    if (visibleLines.length === 0) {
      if (selectedLineId) {
        setSelectedLineId("");
      }
      return;
    }

    const selectedLineStillVisible = visibleLines.some(
      (line) => line.id === selectedLineId,
    );

    if (!selectedLineStillVisible) {
      setSelectedLineId(visibleLines[0].id);
    }
  }, [selectedLineId, showActiveLinesOnly, visibleLines]);

  useEffect(() => {
    if (!followedVehicleId) {
      return;
    }

    if (vehicles.some((vehicle) => vehicle.vehicleId === followedVehicleId)) {
      return;
    }

    if (previousLiveTrackingRouteIdBeforeFollowRef.current !== undefined) {
      setLiveTrackingRouteId(previousLiveTrackingRouteIdBeforeFollowRef.current);
      previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
    }
    setFollowedVehicleId(null);
    setVehicleTrackingNotice("El vehículo seguido ya no está disponible.");
    setFollowedVehicleStopState(null);
  }, [followedVehicleId, vehicles]);

  useEffect(() => {
    if (!followedVehicleId) {
      return;
    }

    if (
      visibleLiveTrackingVehicles.some(
        (vehicle) => vehicle.vehicleId === followedVehicleId,
      )
    ) {
      return;
    }

    if (previousLiveTrackingRouteIdBeforeFollowRef.current !== undefined) {
      setLiveTrackingRouteId(previousLiveTrackingRouteIdBeforeFollowRef.current);
      previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
    }
    setFollowedVehicleId(null);
    setFollowedVehicleStopState(null);
  }, [followedVehicleId, visibleLiveTrackingVehicles]);

  useEffect(() => {
    if (!followedVehicle || !followedVehicleNextStop || !selectedLineId) {
      setFollowedVehicleStopState(null);
      return;
    }

    let active = true;
    const stopId = followedVehicleNextStop.id;
    const stopName = followedVehicleNextStop.name;
    const trackedVehicleId = followedVehicle.vehicleId;

    async function loadTrackedStopArrival() {
      try {
        const response = await fetch(`/api/stops/${stopId}/arrivals`);
        if (!response.ok) {
          throw new Error("No se pudo cargar la llegada de la próxima parada.");
        }

        const data = (await response.json()) as StopArrivalsResponse;
        if (!active) {
          return;
        }

        const exactArrival = data.arrivals.find(
          (arrival) =>
            arrival.vehicleId === trackedVehicleId &&
            arrival.lineId === selectedLineId,
        );

        if (exactArrival) {
          setFollowedVehicleStopState({
            mode: "real",
            stopId,
            stopName,
            etaLabel: formatEtaLabel(exactArrival.etaSeconds),
          });
          return;
        }

        setFollowedVehicleStopState({
          mode: "stop-only",
          stopId,
          stopName,
          note: "Tiempo real no disponible",
        });
      } catch {
        if (active) {
          setFollowedVehicleStopState({
            mode: "stop-only",
            stopId,
            stopName,
            note: "Tiempo real no disponible",
          });
        }
      }
    }

    void loadTrackedStopArrival();

    const intervalId = window.setInterval(() => {
      void loadTrackedStopArrival();
    }, REALTIME_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [followedVehicle, followedVehicleNextStop, selectedLineId]);

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

  function startFollowingVehicle(vehicle: VehiclePosition) {
    setVehicleTrackingNotice(null);
    if (previousLiveTrackingRouteIdBeforeFollowRef.current === undefined) {
      previousLiveTrackingRouteIdBeforeFollowRef.current = liveTrackingRouteId;
    }
    setIsLiveTrackingEnabled(true);
    if (vehicle.routeId && routes.some((route) => route.routeId === vehicle.routeId)) {
      setLiveTrackingRouteId(vehicle.routeId);
    } else {
      setLiveTrackingRouteId(null);
    }
    setFollowedVehicleId(vehicle.vehicleId);
  }

  function stopFollowingVehicle() {
    setFollowedVehicleId(null);
    setFollowedVehicleStopState(null);
    if (previousLiveTrackingRouteIdBeforeFollowRef.current !== undefined) {
      setLiveTrackingRouteId(previousLiveTrackingRouteIdBeforeFollowRef.current);
      previousLiveTrackingRouteIdBeforeFollowRef.current = undefined;
    }
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

    const fallbackStop = buildFavoriteStopPlaceholder(favoriteStop);
    const currentLineStop = routes
      .flatMap((route) => route.stops)
      .find((stop) => stop.id === favoriteStop.id);

    setStopPanel(null);
    setStopError(null);

    if (currentLineStop) {
      setSelectedStop(currentLineStop);
      return;
    }

    setSelectedStop(fallbackStop);

    if (
      favoriteStop.lineId &&
      favoriteStop.lineId !== selectedLineId &&
      lines.some((line) => line.id === favoriteStop.lineId)
    ) {
      if (showActiveLinesOnly) {
        setShowActiveLinesOnly(false);
      }

      pendingFavoriteStopIdRef.current = favoriteStop.id;
      setSelectedLineId(favoriteStop.lineId);
    }
  }

  function toggleShowActiveLinesOnly() {
    if (showActiveLinesOnly) {
      setShowActiveLinesOnly(false);

      const previousLineId = previousUnfilteredLineIdRef.current;
      if (previousLineId && lines.some((line) => line.id === previousLineId)) {
        setSelectedLineId(previousLineId);
      }

      return;
    }

    previousUnfilteredLineIdRef.current = selectedLineId || null;
    setShowActiveLinesOnly(true);
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
            <div
              className="theme-switch"
              data-active-theme={theme}
              role="group"
              aria-label="Selector de tema visual"
            >
              <span className="theme-switch__thumb" aria-hidden="true" />
              <button
                type="button"
                className={`theme-toggle__button theme-toggle__button--mode${
                  theme === "light" ? " is-active" : ""
                }`}
                aria-label="Activar modo claro"
                title="Modo claro"
                onClick={() => setTheme("light")}
              >
                Claro
              </button>
              <button
                type="button"
                className={`theme-toggle__button theme-toggle__button--mode${
                  theme === "dark" ? " is-active" : ""
                }`}
                aria-label="Activar modo oscuro"
                title="Modo oscuro"
                onClick={() => setTheme("dark")}
              >
                Oscuro
              </button>
            </div>
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
              Paradas Favoritas
            </button>
          </div>
        </div>

        <div className="topbar-controls">
          <div className="line-picker">
            <div className="line-picker__row">
              <button
                type="button"
                className={`favorite-toggle line-picker__favorite${
                  isSelectedLineFavorite ? " is-active" : ""
                }`}
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
              <label className="field field--compact">
                <span>Linea activa</span>
                <select
                  value={selectedLineId}
                  onChange={(event) => setSelectedLineId(event.target.value)}
                  disabled={loading || visibleLines.length === 0}
                >
                  {visibleLines.length > 0 ? (
                    visibleLines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {getLineOptionLabel(
                          line,
                          favoriteLineIds.includes(line.id),
                        )}
                      </option>
                    ))
                  ) : (
                    <option value="" disabled>
                      No hay lineas en servicio ahora
                    </option>
                  )}
                </select>
              </label>
              <button
                type="button"
                className={`favorite-toggle line-filter-toggle${
                  showActiveLinesOnly ? " is-active" : ""
                }`}
                onClick={toggleShowActiveLinesOnly}
                aria-pressed={showActiveLinesOnly}
                aria-label={
                  showActiveLinesOnly
                    ? "Mostrar todas las lineas"
                    : "Mostrar solo lineas en servicio"
                }
                title={
                  showActiveLinesOnly
                    ? "Mostrar todas las lineas"
                    : "Mostrar solo lineas en servicio"
                }
              >
                <span className="favorite-toggle__label">Ver activas</span>
              </button>
            </div>

            {selectedLine ? (
              <div className="line-picker__live">
                <button
                  type="button"
                  className={`favorite-toggle live-tracking-toggle${
                    isLiveTrackingEnabled ? " is-active" : ""
                  }`}
                  onClick={() => {
                    setIsLiveTrackingEnabled((current) => {
                      const nextValue = !current;
                      if (!nextValue) {
                        setLiveTrackingRouteId(null);
                      }
                      return nextValue;
                    });
                  }}
                  aria-pressed={isLiveTrackingEnabled}
                  aria-label={
                    isLiveTrackingEnabled
                      ? "Desactivar seguimiento en vivo"
                      : "Activar seguimiento en vivo"
                  }
                  title={
                    isLiveTrackingEnabled
                      ? "Desactivar seguimiento en vivo"
                      : "Activar seguimiento en vivo"
                  }
                >
                  <span className="favorite-toggle__label">
                    Seguimiento en vivo
                  </span>
                </button>
                <span className="line-picker__live-meta">
                  {vehicles.length}{" "}
                  {vehicles.length === 1
                    ? "vehículo"
                    : "vehículos"} visibles
                </span>
              </div>
            ) : null}

            {isLiveTrackingEnabled && canFilterLiveTrackingByRoute ? (
              <div
                className="live-tracking-route-picker"
                aria-label="Filtrar seguimiento en vivo por recorrido"
              >
                <button
                  type="button"
                  className={`favorite-line-chip${
                    liveTrackingRouteId === null ? " is-active" : ""
                  }`}
                  onClick={() => setLiveTrackingRouteId(null)}
                >
                  Línea completa
                </button>
                {liveTrackingRouteOptions.map((route) => (
                  <button
                    key={route.id}
                    type="button"
                    className={`favorite-line-chip${
                      liveTrackingRouteId === route.id ? " is-active" : ""
                    }`}
                    onClick={() => setLiveTrackingRouteId(route.id)}
                  >
                    {route.label}
                  </button>
                ))}
              </div>
            ) : null}

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
          {followedVehicle ? (
            <div className="live-tracking-pill live-tracking-pill--follow" aria-live="polite">
              <span className="live-tracking-pill__eyebrow">Siguiendo bus</span>
              <strong className="live-tracking-pill__title">
                {getVehicleTrackingLabel(followedVehicle.vehicleId)}
              </strong>
              {followedVehicleStopState ? (
                <div className="live-tracking-pill__meta">
                  <span className="live-tracking-pill__stop">
                    Próxima: {followedVehicleStopState.stopName}
                  </span>
                  <span className="live-tracking-pill__eta">
                    {followedVehicleStopState.mode === "real"
                      ? followedVehicleStopState.etaLabel
                      : followedVehicleStopState.note}
                  </span>
                </div>
              ) : followedVehicleNextStop ? (
                <div className="live-tracking-pill__meta">
                  <span className="live-tracking-pill__stop">
                    Próxima: {followedVehicleNextStop.name}
                  </span>
                  <span className="live-tracking-pill__eta">
                    Tiempo real no disponible
                  </span>
                </div>
              ) : (
                <div className="live-tracking-pill__meta">
                  <span className="live-tracking-pill__stop">
                    Próxima parada no disponible
                  </span>
                </div>
              )}
              <div className="live-tracking-pill__actions">
                <button
                  type="button"
                  className="live-tracking-pill__button"
                  onClick={stopFollowingVehicle}
                >
                  Detener
                </button>
              </div>
            </div>
          ) : vehicleTrackingNotice ? (
            <div
              className="live-tracking-pill live-tracking-pill--notice"
              aria-live="polite"
            >
              <span className="live-tracking-pill__eyebrow">
                Seguimiento detenido
              </span>
              <strong className="live-tracking-pill__title">
                {vehicleTrackingNotice}
              </strong>
              <div className="live-tracking-pill__actions">
                <button
                  type="button"
                  className="live-tracking-pill__button"
                  onClick={() => setVehicleTrackingNotice(null)}
                >
                  Cerrar
                </button>
              </div>
            </div>
          ) : isLiveTrackingEnabled && selectedLine ? (
            <div className="live-tracking-pill" aria-live="polite">
              <span className="live-tracking-pill__eyebrow">
                Seguimiento en vivo
              </span>
              <strong className="live-tracking-pill__title">
                {vehicles.length}{" "}
                {vehicles.length === 1
                  ? "vehículo"
                  : "vehículos"}
              </strong>
            </div>
          ) : null}
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
                    onClick={() => {
                      setIsNearbyPanelMinimized(true);
                      setIsNearbyListExpanded(false);
                    }}
                    aria-label="Minimizar panel de paradas cercanas"
                    title="Minimizar panel"
                  >
                    <span className="stop-card__collapse-icon" aria-hidden="true">
                      −
                    </span>
                    <span className="stop-card__collapse-label">Ocultar</span>
                  </button>
                </div>
                <div
                  className={`nearby-stop-list${
                    isNearbyListExpanded ? " nearby-stop-list--expanded" : ""
                  }`}
                  aria-label="Lista de paradas cercanas"
                >
                  {visibleNearbyStops.map((item) => (
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
                {nearbyStops.length > 4 ? (
                  <div className="nearby-stop-list__footer">
                    <button
                      type="button"
                      className="nearby-stop-list__toggle"
                      onClick={() =>
                        setIsNearbyListExpanded((current) => !current)
                      }
                      aria-expanded={isNearbyListExpanded}
                    >
                      {isNearbyListExpanded
                        ? "Ver menos"
                        : `Ver más (${nearbyStops.length - 4} más)`}
                    </button>
                  </div>
                ) : null}
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
          ) : isDefaultInfoPanelMinimized ? (
            <button
              type="button"
              className="info-panel-toggle"
              onClick={() => setIsDefaultInfoPanelMinimized(false)}
              aria-label="Mostrar panel informativo del mapa"
              title="Mostrar informacion"
            >
              <span className="info-panel-toggle__icon" aria-hidden="true">
                i
              </span>
            </button>
          ) : (
            <StatusCard
              eyebrow="Detalle de parada"
              title="Selecciona una parada"
              description="Pulsa una parada del mapa para ver sus lineas activas y los proximos tiempos de paso."
              action={
                <button
                  type="button"
                  className="stop-card__collapse"
                  onClick={() => setIsDefaultInfoPanelMinimized(true)}
                  aria-label="Minimizar panel informativo del mapa"
                  title="Minimizar panel"
                >
                  <span className="stop-card__collapse-icon" aria-hidden="true">
                    −
                  </span>
                  <span className="stop-card__collapse-label">Ocultar</span>
                </button>
              }
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
            liveTrackingEnabled={isLiveTrackingEnabled}
            liveTrackingRouteId={
              isLiveTrackingEnabled && canFilterLiveTrackingByRoute
                ? liveTrackingRouteId
                : null
            }
            followedVehicleId={followedVehicleId}
            onFollowVehicle={startFollowingVehicle}
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
  action?: ReactNode;
};

function StatusCard({
  description,
  eyebrow,
  title,
  tone = "neutral",
  children,
  action,
}: StatusCardProps) {
  return (
    <div className={`stop-card stop-card--hint stop-card--state stop-card--${tone}`}>
      {action ? (
        <div className="stop-card__header stop-card__header--compact">
          <div className="stop-card__title-block">
            {eyebrow ? <span className="stop-card__eyebrow">{eyebrow}</span> : null}
            <strong className="stop-card__title">{title}</strong>
            <p className="stop-card__description">{description}</p>
          </div>
          {action}
        </div>
      ) : (
        <>
          {eyebrow ? <span className="stop-card__eyebrow">{eyebrow}</span> : null}
          <strong className="stop-card__title">{title}</strong>
          <p className="stop-card__description">{description}</p>
        </>
      )}
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
