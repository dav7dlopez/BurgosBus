"use client";

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  IconBusStop,
  IconCreditCard,
  IconMoon,
  IconStar,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";

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

const REALTIME_POLL_MS = 6000;
const THEME_STORAGE_KEY = "bus-burgos-theme";
const LAST_SELECTED_LINE_STORAGE_KEY = "bus-burgos-last-selected-line";
const FAVORITE_LINES_STORAGE_KEY = "bus-burgos-favorite-lines";
const FAVORITE_STOPS_STORAGE_KEY = "bus-burgos-favorite-stops";
const DEFAULT_INFO_PANEL_MINIMIZED_STORAGE_KEY =
  "bus-burgos-default-info-panel-minimized";
const NEARBY_STOP_RADIUS_METERS = 1000;
const INITIAL_LINES_RETRY_ATTEMPTS = 3;
const INITIAL_LINES_RETRY_DELAY_MS = 1400;
const BONOBUR_CARD_STORAGE_KEY = "bus-burgos-bonobur-card";

type BonoburBalanceSuccess = {
  ok: true;
  status: "success";
  observedAt: string;
  balanceEuros: number | null;
  validity: string | null;
  pendingTopUpEuros: number | null;
  pendingTopUpDate: string | null;
};

type BonoburBalanceFailure = {
  ok: false;
  status: "functional_error" | "technical_error";
  message: string;
};

type BonoburBalanceResponse = BonoburBalanceSuccess | BonoburBalanceFailure;

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

function maskBonoburCard(cardNumber: string) {
  const lastDigits = cardNumber.slice(-4);
  return `**** **** ${lastDigits}`;
}

function formatBonoburEuros(value: number) {
  return value.toLocaleString("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

type LinePickerDragState = {
  panel: "linePicker" | "liveTrackingPill" | "stopCard" | "favoritesPanel";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  stageLeft: number;
  stageTop: number;
  stageRight: number;
  stageBottom: number;
  panelStartLeft: number;
  panelStartTop: number;
  panelWidth: number;
  panelHeight: number;
  startOffsetX: number;
  startOffsetY: number;
  hasMoved: boolean;
};

export function TransitDashboard() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [favoriteStopsPanelOpen, setFavoriteStopsPanelOpen] = useState(false);
  const [favoritesPanelTab, setFavoritesPanelTab] = useState<"lines" | "stops">(
    "lines",
  );
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [nearbyModeEnabled, setNearbyModeEnabled] = useState(false);
  const [isNearbyPanelMinimized, setIsNearbyPanelMinimized] = useState(false);
  const [isNearbyListExpanded, setIsNearbyListExpanded] = useState(false);
  const [isDefaultInfoPanelMinimized, setIsDefaultInfoPanelMinimized] =
    useState(false);
  const [showActiveLinesOnly, setShowActiveLinesOnly] = useState(false);
  const [isLiveTrackingEnabled, setIsLiveTrackingEnabled] = useState(false);
  const [liveTrackingRouteId, setLiveTrackingRouteId] = useState<string | null>(null);
  const [isLiveTrackingClusterExpandedDuringFollow, setIsLiveTrackingClusterExpandedDuringFollow] =
    useState(false);
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
  const [bonoburPanelOpen, setBonoburPanelOpen] = useState(false);
  const [bonoburCardInput, setBonoburCardInput] = useState("");
  const [bonoburRememberCard, setBonoburRememberCard] = useState(false);
  const [savedBonoburCard, setSavedBonoburCard] = useState<string | null>(null);
  const [bonoburEditingCard, setBonoburEditingCard] = useState(false);
  const [bonoburLoading, setBonoburLoading] = useState(false);
  const [bonoburError, setBonoburError] = useState<string | null>(null);
  const [bonoburFunctionalError, setBonoburFunctionalError] = useState<
    string | null
  >(null);
  const [bonoburBalance, setBonoburBalance] = useState<BonoburBalanceSuccess | null>(
    null,
  );
  const geolocationWatchId = useRef<number | null>(null);
  const lastSelectedLineIdRef = useRef<string | null>(null);
  const lastVehicleTrackingLineIdRef = useRef<string | null>(null);
  const lastFollowedVehicleIdRef = useRef<string | null>(null);
  const previousLiveTrackingRouteIdBeforeFollowRef = useRef<
    string | null | undefined
  >(undefined);
  const previousUnfilteredLineIdRef = useRef<string | null>(null);
  const preserveSelectedStopRef = useRef<Stop | null>(null);
  const pendingFavoriteStopIdRef = useRef<string | null>(null);
  const bonoburMenuRef = useRef<HTMLDivElement | null>(null);
  const bonoburAutoHydratedCardRef = useRef<string | null>(null);
  const mapStageRef = useRef<HTMLElement | null>(null);
  const linePickerRef = useRef<HTMLDivElement | null>(null);
  const liveTrackingPillRef = useRef<HTMLDivElement | null>(null);
  const stopCardRef = useRef<HTMLDivElement | null>(null);
  const favoritesPanelRef = useRef<HTMLDivElement | null>(null);
  const linePickerDragStateRef = useRef<LinePickerDragState | null>(null);
  const [linePickerOffset, setLinePickerOffset] = useState({ x: 0, y: 0 });
  const [isLinePickerDragging, setIsLinePickerDragging] = useState(false);
  const [liveTrackingPillOffset, setLiveTrackingPillOffset] = useState({
    x: 0,
    y: 0,
  });
  const [isLiveTrackingPillDragging, setIsLiveTrackingPillDragging] =
    useState(false);
  const [stopCardOffset, setStopCardOffset] = useState({ x: 0, y: 0 });
  const [isStopCardDragging, setIsStopCardDragging] = useState(false);
  const [favoritesPanelOffset, setFavoritesPanelOffset] = useState({ x: 0, y: 0 });
  const [isFavoritesPanelDragging, setIsFavoritesPanelDragging] = useState(false);
  const suppressClickUntilRef = useRef<number>(0);

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

    // Keep browser chrome color aligned with the in-app theme, especially on iOS.
    const nextThemeColor = theme === "dark" ? "#000000" : "#edf2f6";
    let themeColorMeta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (!themeColorMeta) {
      themeColorMeta = document.createElement("meta");
      themeColorMeta.name = "theme-color";
      document.head.appendChild(themeColorMeta);
    }
    themeColorMeta.removeAttribute("media");
    themeColorMeta.content = nextThemeColor;
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const applyInsets = () => {
      if (!viewport) {
        root.style.setProperty("--browser-ui-top", "0px");
        root.style.setProperty("--browser-ui-right", "0px");
        root.style.setProperty("--browser-ui-bottom", "0px");
        root.style.setProperty("--browser-ui-left", "0px");
        return;
      }

      const keyboardLikelyOpen = window.innerHeight - viewport.height > 260;
      const layoutViewportHeight = Math.max(
        document.documentElement.clientHeight,
        window.innerHeight,
      );
      const layoutViewportWidth = Math.max(
        document.documentElement.clientWidth,
        window.innerWidth,
      );
      const bottomInset = keyboardLikelyOpen
        ? 0
        : Math.max(
            0,
            layoutViewportHeight - (viewport.height + viewport.offsetTop),
          );
      const topInset = Math.max(0, viewport.offsetTop);
      const leftInset = Math.max(0, viewport.offsetLeft);
      const rightInset = Math.max(
        0,
        layoutViewportWidth - (viewport.width + viewport.offsetLeft),
      );

      root.style.setProperty("--browser-ui-top", `${Math.round(topInset)}px`);
      root.style.setProperty("--browser-ui-right", `${Math.round(rightInset)}px`);
      root.style.setProperty("--browser-ui-bottom", `${Math.round(bottomInset)}px`);
      root.style.setProperty("--browser-ui-left", `${Math.round(leftInset)}px`);
    };

    applyInsets();
    viewport?.addEventListener("resize", applyInsets);
    viewport?.addEventListener("scroll", applyInsets);
    window.addEventListener("resize", applyInsets);
    window.addEventListener("orientationchange", applyInsets);

    return () => {
      viewport?.removeEventListener("resize", applyInsets);
      viewport?.removeEventListener("scroll", applyInsets);
      window.removeEventListener("resize", applyInsets);
      window.removeEventListener("orientationchange", applyInsets);
      root.style.setProperty("--browser-ui-top", "0px");
      root.style.setProperty("--browser-ui-right", "0px");
      root.style.setProperty("--browser-ui-bottom", "0px");
      root.style.setProperty("--browser-ui-left", "0px");
    };
  }, []);

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
    if (typeof window === "undefined") {
      return;
    }

    const storedCard = window.localStorage.getItem(BONOBUR_CARD_STORAGE_KEY);
    if (!storedCard) {
      return;
    }

    const normalized = storedCard.trim().replace(/\s+/g, "");
    if (!/^\d{10,13}$/.test(normalized)) {
      window.localStorage.removeItem(BONOBUR_CARD_STORAGE_KEY);
      return;
    }

    setSavedBonoburCard(normalized);
    setBonoburRememberCard(true);
  }, []);

  useEffect(() => {
    if (!bonoburPanelOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (
        bonoburMenuRef.current &&
        event.target instanceof Node &&
        !bonoburMenuRef.current.contains(event.target)
      ) {
        setBonoburPanelOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [bonoburPanelOpen]);

  useEffect(() => {
    if (
      !isLinePickerDragging &&
      !isLiveTrackingPillDragging &&
      !isStopCardDragging &&
      !isFavoritesPanelDragging
    ) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const dragState = linePickerDragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();
      const deltaX = event.clientX - dragState.startClientX;
      const deltaY = event.clientY - dragState.startClientY;
      if (!dragState.hasMoved && Math.hypot(deltaX, deltaY) >= 6) {
        dragState.hasMoved = true;
      }
      const desiredLeft = dragState.panelStartLeft + deltaX;
      const desiredTop = dragState.panelStartTop + deltaY;
      const maxLeft = Math.max(
        dragState.stageLeft,
        dragState.stageRight - dragState.panelWidth,
      );
      const maxTop = Math.max(
        dragState.stageTop,
        dragState.stageBottom - dragState.panelHeight,
      );
      const clampedLeft = Math.min(Math.max(desiredLeft, dragState.stageLeft), maxLeft);
      const clampedTop = Math.min(Math.max(desiredTop, dragState.stageTop), maxTop);

      const nextOffset = {
        x: dragState.startOffsetX + (clampedLeft - dragState.panelStartLeft),
        y: dragState.startOffsetY + (clampedTop - dragState.panelStartTop),
      };

      if (dragState.panel === "linePicker") {
        setLinePickerOffset(nextOffset);
      } else if (dragState.panel === "liveTrackingPill") {
        setLiveTrackingPillOffset(nextOffset);
      } else if (dragState.panel === "stopCard") {
        setStopCardOffset(nextOffset);
      } else {
        setFavoritesPanelOffset(nextOffset);
      }
    }

    function handlePointerEnd(event: PointerEvent) {
      const dragState = linePickerDragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      linePickerDragStateRef.current = null;
      if (dragState.panel === "linePicker") {
        setIsLinePickerDragging(false);
      } else if (dragState.panel === "liveTrackingPill") {
        setIsLiveTrackingPillDragging(false);
      } else if (dragState.panel === "stopCard") {
        setIsStopCardDragging(false);
      } else {
        setIsFavoritesPanelDragging(false);
      }
      if (dragState.hasMoved) {
        suppressClickUntilRef.current = Date.now() + 220;
      }
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [
    isFavoritesPanelDragging,
    isLinePickerDragging,
    isLiveTrackingPillDragging,
    isStopCardDragging,
  ]);

  useEffect(() => {
    const activeDrag = linePickerDragStateRef.current;
    if (!activeDrag) {
      return;
    }

    if (activeDrag.panel === "liveTrackingPill" && !liveTrackingPillRef.current) {
      linePickerDragStateRef.current = null;
      setIsLiveTrackingPillDragging(false);
    }

    if (activeDrag.panel === "stopCard" && !stopCardRef.current) {
      linePickerDragStateRef.current = null;
      setIsStopCardDragging(false);
    }

    if (activeDrag.panel === "favoritesPanel" && !favoritesPanelRef.current) {
      linePickerDragStateRef.current = null;
      setIsFavoritesPanelDragging(false);
    }
  }, [
    favoriteLineIds.length,
    favoriteStops.length,
    favoriteStopsPanelOpen,
    followedVehicleId,
    vehicleTrackingNotice,
    selectedStop,
    nearbyModeEnabled,
    nearbyStopsLoading,
    nearbyStopsResolved,
    nearbyStops.length,
    geolocationStatus,
    isDefaultInfoPanelMinimized,
  ]);

  function clampAllDraggablePanelsToViewport() {
    function clampPanelToViewport(
      panelRef: HTMLDivElement | null,
      setOffset: (
        updater: (current: { x: number; y: number }) => { x: number; y: number },
      ) => void,
    ) {
      if (!mapStageRef.current || !panelRef) {
        return;
      }

      const stageRect = mapStageRef.current.getBoundingClientRect();
      const panelRect = panelRef.getBoundingClientRect();
      let adjustX = 0;
      let adjustY = 0;

      if (panelRect.left < stageRect.left) {
        adjustX = stageRect.left - panelRect.left;
      } else if (panelRect.right > stageRect.right) {
        adjustX = stageRect.right - panelRect.right;
      }

      if (panelRect.top < stageRect.top) {
        adjustY = stageRect.top - panelRect.top;
      } else if (panelRect.bottom > stageRect.bottom) {
        adjustY = stageRect.bottom - panelRect.bottom;
      }

      if (adjustX !== 0 || adjustY !== 0) {
        setOffset((current) => ({
          x: current.x + adjustX,
          y: current.y + adjustY,
        }));
      }
    }

    clampPanelToViewport(linePickerRef.current, setLinePickerOffset);
    clampPanelToViewport(liveTrackingPillRef.current, setLiveTrackingPillOffset);
    clampPanelToViewport(stopCardRef.current, setStopCardOffset);
    clampPanelToViewport(favoritesPanelRef.current, setFavoritesPanelOffset);
  }

  useEffect(() => {
    window.addEventListener("resize", clampAllDraggablePanelsToViewport);
    window.addEventListener("orientationchange", clampAllDraggablePanelsToViewport);

    return () => {
      window.removeEventListener("resize", clampAllDraggablePanelsToViewport);
      window.removeEventListener("orientationchange", clampAllDraggablePanelsToViewport);
    };
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      clampAllDraggablePanelsToViewport();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    selectedStop,
    stopPanel,
    stopError,
    nearbyModeEnabled,
    nearbyStopsResolved,
    nearbyStopsLoading,
    isNearbyPanelMinimized,
    isNearbyListExpanded,
    geolocationStatus,
    isDefaultInfoPanelMinimized,
    followedVehicleId,
    vehicleTrackingNotice,
    followedVehicleStopState,
    isLiveTrackingEnabled,
    liveTrackingRouteId,
    favoriteLineIds.length,
    favoriteStops.length,
    favoriteStopsPanelOpen,
    favoritesPanelTab,
  ]);

  useEffect(() => {
    if (!savedBonoburCard) {
      bonoburAutoHydratedCardRef.current = null;
      return;
    }

    if (bonoburAutoHydratedCardRef.current === savedBonoburCard) {
      return;
    }

    bonoburAutoHydratedCardRef.current = savedBonoburCard;
    void fetchBonoburBalance(savedBonoburCard, true);
  }, [savedBonoburCard]);

  useEffect(() => {
    let isMounted = true;

    function waitForRetry(delayMs: number) {
      return new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });
    }

    async function loadLines() {
      setLoading(true);
      setLineError(null);
      let lastError: unknown = null;
      try {
        for (
          let attempt = 1;
          attempt <= INITIAL_LINES_RETRY_ATTEMPTS;
          attempt += 1
        ) {
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
            return;
          } catch (error) {
            lastError = error;
            if (attempt < INITIAL_LINES_RETRY_ATTEMPTS) {
              await waitForRetry(INITIAL_LINES_RETRY_DELAY_MS);
              continue;
            }
          }
        }

        throw lastError ?? new Error("No se pudieron cargar las lineas.");
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
  const isFollowingBus = followedVehicleId !== null;
  const isLiveTrackingClusterCollapsed =
    isFollowingBus && !isLiveTrackingClusterExpandedDuringFollow;
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
    if (!favoriteStopsPanelOpen) {
      return;
    }

    if (favoritesPanelTab === "lines" && favoriteLines.length === 0 && favoriteStops.length > 0) {
      setFavoritesPanelTab("stops");
      return;
    }

    if (favoritesPanelTab === "stops" && favoriteStops.length === 0 && favoriteLines.length > 0) {
      setFavoritesPanelTab("lines");
    }
  }, [
    favoriteLines.length,
    favoriteStops.length,
    favoriteStopsPanelOpen,
    favoritesPanelTab,
  ]);

  useEffect(() => {
    if (lines.length === 0) {
      return;
    }

    setFavoriteLineIds((current) =>
      current.filter((lineId) => lines.some((line) => line.id === lineId)),
    );
  }, [lines]);

  useEffect(() => {
    if (!isLiveTrackingClusterCollapsed || !isMobileLegendOpen) {
      return;
    }

    setIsMobileLegendOpen(false);
  }, [isLiveTrackingClusterCollapsed, isMobileLegendOpen]);

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
    if (!followedVehicleId) {
      setIsLiveTrackingClusterExpandedDuringFollow(false);
      lastFollowedVehicleIdRef.current = null;
      return;
    }

    if (lastFollowedVehicleIdRef.current !== followedVehicleId) {
      setIsLiveTrackingClusterExpandedDuringFollow(false);
    }

    lastFollowedVehicleIdRef.current = followedVehicleId;
  }, [followedVehicleId]);

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

  function removeFavoriteLine(lineId: string) {
    setFavoriteLineIds((current) =>
      current.filter((favoriteId) => favoriteId !== lineId),
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

  function removeFavoriteStop(stopId: string) {
    setFavoriteStops((current) =>
      current.filter((favoriteStop) => favoriteStop.id !== stopId),
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

  async function fetchBonoburBalance(cardNumber: string, shouldRemember: boolean) {
    const normalizedCard = cardNumber.trim().replace(/\s+/g, "");
    setBonoburLoading(true);
    setBonoburError(null);
    setBonoburFunctionalError(null);

    try {
      const response = await fetch("/api/bonobur/balance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ numeroTarjeta: normalizedCard }),
      });

      const data = (await response.json()) as BonoburBalanceResponse;
      if (!response.ok) {
        throw new Error(
          data.ok ? "No se pudo consultar el saldo BONOBUR." : data.message,
        );
      }

      if (!data.ok) {
        if (data.status === "functional_error") {
          setBonoburFunctionalError(data.message);
          setBonoburBalance(null);
          return;
        }

        throw new Error(data.message);
      }

      setBonoburBalance(data);
      if (shouldRemember) {
        setSavedBonoburCard(normalizedCard);
        setBonoburRememberCard(true);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(BONOBUR_CARD_STORAGE_KEY, normalizedCard);
        }
        setBonoburEditingCard(false);
      } else {
        setSavedBonoburCard(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(BONOBUR_CARD_STORAGE_KEY);
        }
      }
    } catch (error) {
      setBonoburBalance(null);
      setBonoburError(
        error instanceof Error
          ? error.message
          : "Servicio BONOBUR temporalmente no disponible.",
      );
    } finally {
      setBonoburLoading(false);
    }
  }

  function handleBonoburSubmit() {
    void fetchBonoburBalance(bonoburCardInput, bonoburRememberCard);
  }

  function handleBonoburRefresh() {
    const cardForQuery =
      !bonoburEditingCard && savedBonoburCard ? savedBonoburCard : bonoburCardInput;

    if (!cardForQuery.trim()) {
      setBonoburError("Introduce el número de tarjeta BONOBUR.");
      setBonoburFunctionalError(null);
      return;
    }

    void fetchBonoburBalance(cardForQuery, !bonoburEditingCard && !!savedBonoburCard);
  }

  function clearBonoburStoredCard() {
    setSavedBonoburCard(null);
    setBonoburEditingCard(false);
    setBonoburCardInput("");
    setBonoburRememberCard(false);
    setBonoburBalance(null);
    setBonoburError(null);
    setBonoburFunctionalError(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(BONOBUR_CARD_STORAGE_KEY);
    }
  }

  const bonoburButtonBalanceLabel =
    savedBonoburCard &&
    bonoburBalance &&
    bonoburBalance.balanceEuros !== null
      ? formatBonoburEuros(bonoburBalance.balanceEuros)
      : null;

  function startDragForPanel(
    event: ReactPointerEvent<HTMLDivElement>,
    panel: "linePicker" | "liveTrackingPill" | "stopCard" | "favoritesPanel",
    panelRef: HTMLDivElement | null,
    startOffset: { x: number; y: number },
  ) {
    if (!mapStageRef.current || !panelRef) {
      return;
    }

    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const dragOrigin =
      event.target instanceof Element ? event.target : event.currentTarget;
    const isInteractiveTarget = Boolean(
      dragOrigin.closest(
        "button, select, input, textarea, a, label, [role='button'], [data-no-drag]",
      ),
    );

    if (isInteractiveTarget) {
      return;
    }

    const stageRect = mapStageRef.current.getBoundingClientRect();
    const panelRect = panelRef.getBoundingClientRect();

    linePickerDragStateRef.current = {
      panel,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      stageLeft: stageRect.left,
      stageTop: stageRect.top,
      stageRight: stageRect.right,
      stageBottom: stageRect.bottom,
      panelStartLeft: panelRect.left,
      panelStartTop: panelRect.top,
      panelWidth: panelRect.width,
      panelHeight: panelRect.height,
      startOffsetX: startOffset.x,
      startOffsetY: startOffset.y,
      hasMoved: false,
    };

    event.preventDefault();
    event.stopPropagation();
    if (panel === "linePicker") {
      setIsLinePickerDragging(true);
    } else if (panel === "liveTrackingPill") {
      setIsLiveTrackingPillDragging(true);
    } else if (panel === "stopCard") {
      setIsStopCardDragging(true);
    } else {
      setIsFavoritesPanelDragging(true);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleLinePickerDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    startDragForPanel(event, "linePicker", linePickerRef.current, linePickerOffset);
  }

  function handleLiveTrackingPillDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    startDragForPanel(
      event,
      "liveTrackingPill",
      liveTrackingPillRef.current,
      liveTrackingPillOffset,
    );
  }

  function handleStopCardDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    startDragForPanel(event, "stopCard", stopCardRef.current, stopCardOffset);
  }

  function handleFavoritesPanelDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    startDragForPanel(
      event,
      "favoritesPanel",
      favoritesPanelRef.current,
      favoritesPanelOffset,
    );
  }

  function handleDraggablePanelClickCapture(event: React.MouseEvent<HTMLElement>) {
    if (Date.now() <= suppressClickUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const stopCardDraggableClass = `stop-card--draggable${
    isStopCardDragging ? " is-dragging" : ""
  }`;
  const stopCardDraggableStyle = {
    transform: `translate3d(${stopCardOffset.x}px, ${stopCardOffset.y}px, 0)`,
  } satisfies CSSProperties;
  const favoritesPanelDraggableClass = `favorites-panel--draggable${
    isFavoritesPanelDragging ? " is-dragging" : ""
  }`;
  const favoritesPanelDraggableStyle = {
    transform: `translate3d(${favoritesPanelOffset.x}px, ${favoritesPanelOffset.y}px, 0)`,
  } satisfies CSSProperties;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-head">
          <div className="brand-lockup">
            <p className="eyebrow">Tiempo real</p>
            <h1>Autobuses Burgos</h1>
          </div>

          <div className="theme-toggle" aria-label="Selector de tema">
            <div className="topbar-theme-mode">
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
                  <IconSun
                    size={15}
                    strokeWidth={2}
                    aria-hidden="true"
                    focusable="false"
                    className="theme-toggle__icon theme-toggle__icon--mode"
                  />
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
                  <IconMoon
                    size={15}
                    strokeWidth={2}
                    aria-hidden="true"
                    focusable="false"
                    className="theme-toggle__icon theme-toggle__icon--mode"
                  />
                </button>
              </div>
              <div className="bonobur-menu" ref={bonoburMenuRef}>
                <button
                  type="button"
                  className={`theme-toggle__button theme-toggle__button--bonobur${
                    bonoburPanelOpen ? " is-active" : ""
                  }${
                    bonoburButtonBalanceLabel ? " is-balance" : ""
                  }`}
                  aria-label="Consultar saldo BONOBUR"
                  aria-expanded={bonoburPanelOpen}
                  aria-controls="bonobur-popover"
                  title={
                    bonoburButtonBalanceLabel
                      ? `Saldo BONOBUR: ${bonoburButtonBalanceLabel}`
                      : "Consultar saldo BONOBUR"
                  }
                  onClick={() => setBonoburPanelOpen((current) => !current)}
                >
                  {bonoburButtonBalanceLabel ? (
                    <span className="theme-toggle__bonobur-balance">
                      {bonoburButtonBalanceLabel}
                    </span>
                  ) : (
                    <IconCreditCard
                      size={15}
                      strokeWidth={2}
                      aria-hidden="true"
                      focusable="false"
                      className="theme-toggle__icon"
                    />
                  )}
                </button>
                {bonoburPanelOpen ? (
                  <div
                    id="bonobur-popover"
                    className="bonobur-popover"
                    role="dialog"
                    aria-label="Panel de saldo BONOBUR"
                  >
                    <span className="bonobur-popover__eyebrow">BONOBUR</span>
                    <strong className="bonobur-popover__title">Consulta de saldo</strong>
                    {savedBonoburCard && !bonoburEditingCard ? (
                      <div className="bonobur-popover__saved-card">
                        <span className="bonobur-popover__label">Tarjeta guardada</span>
                        <strong>{maskBonoburCard(savedBonoburCard)}</strong>
                        <button
                          type="button"
                          className="bonobur-popover__link"
                          onClick={() => {
                            setBonoburEditingCard(true);
                            setBonoburFunctionalError(null);
                            setBonoburError(null);
                          }}
                        >
                          Usar otra tarjeta
                        </button>
                      </div>
                    ) : (
                      <div className="bonobur-popover__field">
                        <label htmlFor="bonobur-card-input">Número de tarjeta</label>
                        <input
                          id="bonobur-card-input"
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="Solo dígitos"
                          value={bonoburCardInput}
                          onChange={(event) => {
                            setBonoburCardInput(event.target.value.replace(/[^\d]/g, ""));
                            setBonoburError(null);
                            setBonoburFunctionalError(null);
                          }}
                        />
                        <label className="bonobur-popover__remember">
                          <input
                            type="checkbox"
                            checked={bonoburRememberCard}
                            onChange={(event) =>
                              setBonoburRememberCard(event.target.checked)
                            }
                          />
                          <span>Recordar en este dispositivo</span>
                        </label>
                      </div>
                    )}

                    {bonoburBalance ? (
                      <div className="bonobur-popover__result bonobur-popover__result--success">
                        <span className="bonobur-popover__label">Saldo actual</span>
                        <strong>
                          {bonoburBalance.balanceEuros !== null
                            ? formatBonoburEuros(bonoburBalance.balanceEuros)
                            : "No disponible"}
                        </strong>
                        {bonoburBalance.pendingTopUpEuros !== null ? (
                          <span className="bonobur-popover__meta">
                            Recarga pendiente:{" "}
                            {formatBonoburEuros(bonoburBalance.pendingTopUpEuros)}
                          </span>
                        ) : null}
                        <span className="bonobur-popover__meta">
                          Última actualización:{" "}
                          {new Date(bonoburBalance.observedAt).toLocaleTimeString("es-ES", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    ) : null}

                    {bonoburFunctionalError ? (
                      <div className="bonobur-popover__result bonobur-popover__result--warning">
                        {bonoburFunctionalError}
                      </div>
                    ) : null}
                    {bonoburError ? (
                      <div className="bonobur-popover__result bonobur-popover__result--error">
                        {bonoburError}
                      </div>
                    ) : null}

                    <div className="bonobur-popover__actions">
                      {!savedBonoburCard || bonoburEditingCard ? (
                        <button
                          type="button"
                          className="bonobur-popover__button"
                          onClick={handleBonoburSubmit}
                          disabled={bonoburLoading}
                        >
                          {bonoburLoading ? "Consultando..." : "Consultar saldo"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="bonobur-popover__button"
                          onClick={handleBonoburRefresh}
                          disabled={bonoburLoading}
                        >
                          {bonoburLoading ? "Actualizando..." : "Actualizar"}
                        </button>
                      )}
                      {savedBonoburCard ? (
                        <button
                          type="button"
                          className="bonobur-popover__button bonobur-popover__button--secondary"
                          onClick={clearBonoburStoredCard}
                          disabled={bonoburLoading}
                        >
                          Olvidar tarjeta
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="topbar-quick-actions">
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
                <span className="theme-toggle__utility-label">GPS</span>
                <span className="theme-toggle__utility-state" aria-hidden="true">
                  {locationEnabled ? "ON" : "OFF"}
                </span>
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
                <IconBusStop
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                  focusable="false"
                  className="theme-toggle__icon"
                />
                <span className="theme-toggle__utility-label">Cerca</span>
              </button>
              <button
                type="button"
                className={`theme-toggle__button theme-toggle__button--favorites${
                  favoriteStopsPanelOpen ? " is-active" : ""
                }`}
                aria-label={
                  favoriteStopsPanelOpen
                    ? "Ocultar panel de favoritos"
                    : "Mostrar panel de favoritos"
                }
                aria-expanded={favoriteStopsPanelOpen}
                aria-controls="favorites-panel"
                title={
                  favoriteStopsPanelOpen
                    ? "Ocultar favoritos"
                    : "Mostrar favoritos"
                }
                onClick={() => setFavoriteStopsPanelOpen((current) => !current)}
              >
                <IconStar
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                  focusable="false"
                  className="theme-toggle__icon"
                />
                <span className="theme-toggle__utility-label">Favs</span>
              </button>
            </div>
          </div>
        </div>

      </header>

      {lineError ? <p className="error-banner">{lineError}</p> : null}

      <section className="map-stage" ref={mapStageRef}>
        <div className="map-overlay map-overlay--top">
          <div className="map-toolbar">
            <div
              ref={linePickerRef}
              className={`line-picker line-picker--floating line-picker--draggable${
                isLinePickerDragging ? " is-dragging" : ""
              }`}
              onPointerDown={handleLinePickerDragStart}
              onClickCapture={handleDraggablePanelClickCapture}
              style={{
                transform: `translate3d(${linePickerOffset.x}px, ${linePickerOffset.y}px, 0)`,
              }}
            >
              <div className="line-picker__row">
                <div className="field field--compact">
                  <label htmlFor="line-picker-select">Línea</label>
                  <select
                    id="line-picker-select"
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
                    ) : loading ? (
                      <option value="" disabled>
                        Cargando lineas...
                      </option>
                    ) : (
                      <option value="" disabled>
                        No hay lineas en servicio ahora
                      </option>
                    )}
                  </select>
                </div>
                <div className="line-picker__row-actions">
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
                    <span className="favorite-toggle__label favorite-toggle__label--desktop">
                      Ver activas
                    </span>
                    <span className="favorite-toggle__label favorite-toggle__label--mobile">
                      Activas
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="map-overlay map-overlay--context">
          <div className="map-status-cluster">
            {followedVehicle ? (
              <div
                ref={liveTrackingPillRef}
                className={`live-tracking-pill live-tracking-pill--follow live-tracking-pill--draggable${
                  isLiveTrackingPillDragging ? " is-dragging" : ""
                }`}
                onPointerDown={handleLiveTrackingPillDragStart}
                onClickCapture={handleDraggablePanelClickCapture}
                style={{
                  transform: `translate3d(${liveTrackingPillOffset.x}px, ${liveTrackingPillOffset.y}px, 0)`,
                }}
                aria-live="polite"
              >
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
            ) : null}
            {isLiveTrackingClusterCollapsed ? (
              <div
                className="map-live-controls map-live-controls--collapsed"
                aria-label="Controles de seguimiento colapsados"
              >
                <button
                  type="button"
                  className="favorite-toggle map-live-controls__collapsed-trigger"
                  onClick={() => setIsLiveTrackingClusterExpandedDuringFollow(true)}
                  aria-label="Mostrar controles completos de seguimiento en vivo"
                >
                  Mostrar seguimiento
                  {isLiveTrackingEnabled ? (
                    <span className="map-live-controls__collapsed-count">
                      {vehicles.length}
                    </span>
                  ) : null}
                </button>
              </div>
            ) : (
              <>
                {selectedLine ? (
                  <div className="map-live-controls" aria-label="Controles de seguimiento">
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
                      <span className="favorite-toggle__label">Seguimiento en vivo</span>
                    </button>
                    {isLiveTrackingEnabled ? (
                      <span className="line-picker__live-meta line-picker__live-meta--compact">
                        {vehicles.length} {vehicles.length === 1 ? "bus" : "buses"}
                      </span>
                    ) : null}
                    {isFollowingBus ? (
                      <button
                        type="button"
                        className="favorite-toggle map-live-controls__compact-action"
                        onClick={() => setIsLiveTrackingClusterExpandedDuringFollow(false)}
                      >
                        Compactar
                      </button>
                    ) : null}
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
                <div className="map-context-controls">
                  <button
                    type="button"
                    className={`legend-toggle${isMobileLegendOpen ? " is-open" : ""}`}
                    onClick={() => setIsMobileLegendOpen((current) => !current)}
                    aria-expanded={isMobileLegendOpen}
                    aria-controls="route-legend"
                  >
                    <span aria-hidden="true">≋</span>
                    <span className="legend-toggle__label">Recorridos</span>
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
              </>
            )}
            {!followedVehicle && vehicleTrackingNotice ? (
              <div
                ref={liveTrackingPillRef}
                className={`live-tracking-pill live-tracking-pill--notice live-tracking-pill--draggable${
                  isLiveTrackingPillDragging ? " is-dragging" : ""
                }`}
                onPointerDown={handleLiveTrackingPillDragStart}
                onClickCapture={handleDraggablePanelClickCapture}
                style={{
                  transform: `translate3d(${liveTrackingPillOffset.x}px, ${liveTrackingPillOffset.y}px, 0)`,
                }}
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
            ) : null}
          </div>
        </div>

        <div className="map-overlay map-overlay--bottom">
          {favoriteStopsPanelOpen ? (
            <div
              ref={favoritesPanelRef}
              id="favorites-panel"
              className={`favorites-panel ${favoritesPanelDraggableClass}`}
              aria-label="Panel de favoritos"
              onPointerDown={handleFavoritesPanelDragStart}
              onClickCapture={handleDraggablePanelClickCapture}
              style={favoritesPanelDraggableStyle}
            >
              <div className="favorites-panel__header">
                <div className="favorites-panel__header-row">
                  <span className="favorites-panel__eyebrow">Favoritos</span>
                  <button
                    type="button"
                    className="favorites-panel__close"
                    onClick={() => setFavoriteStopsPanelOpen(false)}
                    aria-label="Cerrar panel de favoritos"
                    title="Cerrar favoritos"
                  >
                    ×
                  </button>
                </div>
                <div
                  className="favorites-panel__tabs"
                  role="tablist"
                  aria-label="Tipos de favoritos"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={favoritesPanelTab === "lines"}
                    className={`favorites-panel__tab${
                      favoritesPanelTab === "lines" ? " is-active" : ""
                    }`}
                    onClick={() => setFavoritesPanelTab("lines")}
                  >
                    Líneas
                    <span className="favorites-panel__tab-count">
                      {favoriteLines.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={favoritesPanelTab === "stops"}
                    className={`favorites-panel__tab${
                      favoritesPanelTab === "stops" ? " is-active" : ""
                    }`}
                    onClick={() => setFavoritesPanelTab("stops")}
                  >
                    Paradas
                    <span className="favorites-panel__tab-count">
                      {favoriteStops.length}
                    </span>
                  </button>
                </div>
              </div>
              <div className="favorites-panel__body">
                {favoritesPanelTab === "lines" ? (
                  favoriteLines.length > 0 ? (
                    <div className="favorites-panel__list" role="list">
                      {favoriteLines.map((line) => (
                        <div
                          key={line.id}
                          role="listitem"
                          className={`favorites-panel__item${
                            line.id === selectedLineId ? " is-active" : ""
                          }`}
                        >
                          <button
                            type="button"
                            className="favorites-panel__item-main-button"
                            onClick={() => setSelectedLineId(line.id)}
                            title={`${line.publicCode} ${line.displayName}`}
                          >
                            <span className="favorites-panel__item-main">
                              {line.publicCode} {line.displayName}
                            </span>
                            <span className="favorites-panel__item-meta">
                              {line.isActiveNow === false
                                ? "Sin servicio"
                                : "En servicio"}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="favorites-panel__item-remove"
                            onClick={() => removeFavoriteLine(line.id)}
                            aria-label={`Eliminar línea ${line.publicCode} de favoritas`}
                            title="Eliminar de favoritas"
                            data-no-drag
                          >
                            <IconTrash
                              size={14}
                              strokeWidth={2}
                              aria-hidden="true"
                              focusable="false"
                            />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="favorites-panel__empty">
                      <strong>No hay líneas favoritas aún</strong>
                      <p>Marca una línea con la estrella para verla aquí.</p>
                    </div>
                  )
                ) : favoriteStops.length > 0 ? (
                  <div className="favorites-panel__list" role="list">
                    {favoriteStops.map((favoriteStop) => (
                      <div
                        key={favoriteStop.id}
                        role="listitem"
                        className={`favorites-panel__item${
                          favoriteStop.id === selectedStop?.id ? " is-active" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="favorites-panel__item-main-button"
                          onClick={() => reopenFavoriteStop(favoriteStop)}
                          title={favoriteStop.name}
                        >
                          <span className="favorites-panel__item-main">
                            {favoriteStop.name}
                          </span>
                          <span className="favorites-panel__item-meta">
                            #{favoriteStop.id}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="favorites-panel__item-remove"
                          onClick={() => removeFavoriteStop(favoriteStop.id)}
                          aria-label={`Eliminar parada ${favoriteStop.name} de favoritas`}
                          title="Eliminar de favoritas"
                          data-no-drag
                        >
                          <IconTrash
                            size={14}
                            strokeWidth={2}
                            aria-hidden="true"
                            focusable="false"
                          />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="favorites-panel__empty">
                    <strong>No hay paradas favoritas aún</strong>
                    <p>Guarda una parada desde su panel para tenerla aquí a mano.</p>
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {geolocationStatus === "insecure" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="Activa HTTPS para usar tu posicion"
              description="La ubicacion del navegador solo funciona en un contexto seguro y con permisos del sitio."
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
            />
          ) : geolocationStatus === "denied" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="No hay acceso a tu ubicacion"
              description="Puedes volver a activarla con el boton GPS o revisar los permisos del navegador para este sitio."
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
            />
          ) : geolocationStatus === "unsupported" ? (
            <StatusCard
              eyebrow="Ubicacion"
              title="Este navegador no ofrece geolocalizacion"
              description="La app seguira funcionando con el mapa y las lineas, pero sin funciones basadas en tu posicion."
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
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
              <div
                ref={stopCardRef}
                className={`stop-card stop-card--hint stop-card--state ${stopCardDraggableClass}`}
                onPointerDown={handleStopCardDragStart}
                onClickCapture={handleDraggablePanelClickCapture}
                style={stopCardDraggableStyle}
              >
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
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
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
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
            />
          ) : selectedStop ? (
            <div
              ref={stopCardRef}
              className={`stop-card stop-card--detail ${stopCardDraggableClass}`}
              onPointerDown={handleStopCardDragStart}
              onClickCapture={handleDraggablePanelClickCapture}
              style={stopCardDraggableStyle}
            >
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
              draggableProps={{
                ref: stopCardRef,
                className: stopCardDraggableClass,
                style: stopCardDraggableStyle,
                onPointerDown: handleStopCardDragStart,
                onClickCapture: handleDraggablePanelClickCapture,
              }}
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
  draggableProps?: {
    ref: RefObject<HTMLDivElement | null>;
    className: string;
    style: CSSProperties;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  };
};

function StatusCard({
  description,
  eyebrow,
  title,
  tone = "neutral",
  children,
  action,
  draggableProps,
}: StatusCardProps) {
  return (
    <div
      ref={draggableProps?.ref}
      className={`stop-card stop-card--hint stop-card--state stop-card--${tone}${
        draggableProps ? ` ${draggableProps.className}` : ""
      }`}
      onPointerDown={draggableProps?.onPointerDown}
      onClickCapture={draggableProps?.onClickCapture}
      style={draggableProps?.style}
    >
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
