import { withCache } from "@/lib/cache";
import {
  type ArrivalPrediction,
  type Line,
  type LineDetail,
  type NearbyStopsResponse,
  type RouteShape,
  type Stop,
  type StopArrivalsResponse,
  type VehiclePosition,
} from "@/lib/types";

const BASE_URL = "https://movilidad.aytoburgos.es";
const DIRECT_URL = `${BASE_URL}/rutas-en-directo`;
const JSON_HEADERS = {
  Accept: "application/json, text/plain, */*",
};

const STATIC_TTL_MS = 1000 * 60 * 60;
const ROUTE_TTL_MS = 1000 * 60 * 30;
const REALTIME_TTL_MS = 1000 * 6;
const UPSTREAM_TIMEOUT_MS = 7000;
const UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_RETRY_DELAY_MS = 450;
const UPSTREAM_SLOW_REQUEST_MS = 2500;

type RawStop = {
  tipo: number | string | null;
  lng: number;
  num: string;
  name: string;
  label?: string;
  lat: number;
};

type RawRoute = {
  id: string;
  line: string;
  ida: string | boolean | null;
  label: string;
  latLngs: Array<{ lat: number; lng: number }>;
  routeNode: RawStop[];
};

type RawVehicle = {
  id: number | string;
  ruta?: number | string | null;
  lat: number;
  lng: number;
  desfaseTiempo?: number | null;
  desfaseEspacio?: number | null;
};

type RawEstimationVehicle = {
  seconds: string | number;
  meters?: number | null;
  vehicle?: number | string | null;
  isLastBus?: boolean;
  isPartialTrip?: boolean;
};

type RawEstimationRoute = {
  line: string;
  destination: string;
  publicEstimationVHExts: RawEstimationVehicle[];
};

type RawEstimationNode = {
  tipo: string | number;
  nodoId: string;
  routeEstimationByNode: RawEstimationRoute[];
};

function buildResourceUrl(resourceId: string, params: Record<string, string>) {
  const search = new URLSearchParams({
    p_p_id: "as_asac_isaenext_IsaenextWebPortlet",
    p_p_lifecycle: "2",
    p_p_state: "normal",
    p_p_mode: "view",
    p_p_resource_id: resourceId,
    p_p_cacheability: "cacheLevelPage",
    ...params,
  });

  return `${DIRECT_URL}?${search.toString()}`;
}

class UpstreamHttpError extends Error {
  status: number;

  constructor(status: number, url: string) {
    super(`Municipal upstream failed (${status}) for ${url}`);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

function getUpstreamRequestMeta(url: string) {
  try {
    const parsed = new URL(url);
    const resourceId = parsed.searchParams.get("p_p_resource_id");
    const lineLabel = parsed.searchParams.get(
      "_as_asac_isaenext_IsaenextWebPortlet_label",
    );

    return {
      host: parsed.host,
      path: parsed.pathname,
      resourceId: resourceId ?? "rutas-en-directo",
      lineLabel: lineLabel ?? null,
    };
  } catch {
    return {
      host: BASE_URL,
      path: "/rutas-en-directo",
      resourceId: "unknown",
      lineLabel: null,
    };
  }
}

function logUpstreamWarning(event: string, payload: Record<string, unknown>) {
  console.warn("[burgos-upstream]", event, payload);
}

function logUpstreamError(event: string, payload: Record<string, unknown>) {
  console.error("[burgos-upstream]", event, payload);
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryableUpstreamError(error: unknown) {
  if (error instanceof UpstreamHttpError) {
    return error.status >= 500 || error.status === 429;
  }

  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    return error.name === "AbortError";
  }

  return false;
}

async function fetchWithResilience(url: string, init?: RequestInit) {
  let lastError: unknown = null;
  const meta = getUpstreamRequestMeta(url);

  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const requestStartMs = Date.now();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        next: { revalidate: 0 },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new UpstreamHttpError(response.status, url);
      }

      const durationMs = Date.now() - requestStartMs;
      if (attempt > 1 || durationMs >= UPSTREAM_SLOW_REQUEST_MS) {
        logUpstreamWarning("request_slow_or_retried", {
          ...meta,
          attempt,
          durationMs,
          status: response.status,
        });
      }

      return response;
    } catch (error) {
      lastError = error;
      const hasMoreAttempts = attempt < UPSTREAM_MAX_ATTEMPTS;
      const durationMs = Date.now() - requestStartMs;
      const retryable = isRetryableUpstreamError(error);

      if (hasMoreAttempts && retryable) {
        logUpstreamWarning("request_retry", {
          ...meta,
          attempt,
          durationMs,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } else {
        logUpstreamError("request_failed", {
          ...meta,
          attempt,
          durationMs,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }

      if (!hasMoreAttempts || !retryable) {
        throw error;
      }

      await waitForRetry(UPSTREAM_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error(`Municipal upstream failed for ${url}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchWithResilience(url, {
    headers: JSON_HEADERS,
  });

  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithResilience(url);

  return response.text();
}

function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeStop(stop: RawStop): Stop {
  return {
    id: stop.num,
    code: stop.label ?? null,
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    type: stop.tipo ?? null,
    source: "isaenext",
  };
}

function colorForRoute(index: number) {
  const palette = ["#d1495b", "#00798c", "#edae49", "#30638e"];
  return palette[index % palette.length];
}

function haversineDistanceMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) {
  const earthRadiusMeters = 6371000;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function normalizeRoute(lineId: string, route: RawRoute, index: number): RouteShape {
  const isOutbound =
    route.ida === "true" ? true : route.ida === "false" ? false : null;

  return {
    routeId: route.id,
    lineId,
    directionLabel: route.label,
    isOutbound,
    colorHint: colorForRoute(index),
    path: route.latLngs,
    stops: route.routeNode.map((stop, stopIndex) => ({
      ...normalizeStop(stop),
      sequence: stopIndex + 1,
      routeId: route.id,
      directionLabel: route.label,
      isTerminal: stopIndex === 0 || stopIndex === route.routeNode.length - 1,
    })),
  };
}

export async function getLines(): Promise<Line[]> {
  return withCache("lines", STATIC_TTL_MS, async () => {
    const html = await fetchText(DIRECT_URL);
    const matches = html.matchAll(
      /<option class=""\s+(?:selected\s+)?value="([^"]*)"\s*>([\s\S]*?)<\/option>/g,
    );

    const lines: Line[] = [];
    for (const match of matches) {
      const id = match[1].trim();
      if (!id) {
        continue;
      }

      const rawText = decodeHtml(match[2]).replace(/\s+/g, " ").trim();
      const displayName = rawText.replace(/^\S+\s+/, "").trim();

      lines.push({
        id,
        publicCode: id,
        displayName,
        source: "isaenext",
      });
    }

    return lines;
  });
}

export async function getLinesWithActivity(): Promise<Line[]> {
  return withCache("lines-with-activity", REALTIME_TTL_MS, async () => {
    const lines = await getLines();
    const activityByLine = await Promise.allSettled(
      lines.map(async (line) => {
        const { vehicles } = await getVehiclesByLine(line.id);
        return {
          lineId: line.id,
          activeVehicleCount: vehicles.length,
        };
      }),
    );

    const activityIndex = new Map<string, number>();
    for (const result of activityByLine) {
      if (result.status !== "fulfilled") {
        continue;
      }

      activityIndex.set(result.value.lineId, result.value.activeVehicleCount);
    }

    return lines.map((line) => {
      const activeVehicleCount = activityIndex.get(line.id) ?? 0;

      return {
        ...line,
        activeVehicleCount,
        isActiveNow: activeVehicleCount > 0,
      };
    });
  });
}

export async function getAllStops(): Promise<Stop[]> {
  return withCache("all-stops", ROUTE_TTL_MS, async () => {
    const rawStops = await fetchJson<RawStop[]>(
      buildResourceUrl("resourceNodes", {}),
    );
    return rawStops.map(normalizeStop);
  });
}

export async function getRoutesByLine(lineId: string): Promise<RouteShape[]> {
  return withCache(`routes:${lineId}`, ROUTE_TTL_MS, async () => {
    const rawRoutes = await fetchJson<RawRoute[]>(
      buildResourceUrl("resourceRoutes", {
        _as_asac_isaenext_IsaenextWebPortlet_label: lineId,
      }),
    );

    return rawRoutes.map((route, index) => normalizeRoute(lineId, route, index));
  });
}

export async function getLineDetail(lineId: string): Promise<LineDetail> {
  const [lines, routes] = await Promise.all([getLines(), getRoutesByLine(lineId)]);
  const line = lines.find((item) => item.id === lineId);

  if (!line) {
    throw new Error(`Line ${lineId} not found`);
  }

  return {
    ...line,
    routes,
  };
}

export async function getLineStops(lineId: string): Promise<{
  lineId: string;
  routes: RouteShape[];
}> {
  const routes = await getRoutesByLine(lineId);
  return { lineId, routes };
}

export async function getLineShape(lineId: string): Promise<{
  lineId: string;
  routes: Array<
    Pick<RouteShape, "routeId" | "directionLabel" | "isOutbound" | "colorHint" | "path">
  >;
}> {
  const routes = await getRoutesByLine(lineId);

  return {
    lineId,
    routes: routes.map((route) => ({
      routeId: route.routeId,
      directionLabel: route.directionLabel,
      isOutbound: route.isOutbound,
      colorHint: route.colorHint,
      path: route.path,
    })),
  };
}

export async function getVehiclesByLine(lineId: string): Promise<{
  lineId: string;
  observedAt: string;
  vehicles: VehiclePosition[];
}> {
  return withCache(`vehicles:${lineId}`, REALTIME_TTL_MS, async () => {
    const rawVehicles = await fetchJson<RawVehicle[]>(
      buildResourceUrl("resourceVehicles", {
        _as_asac_isaenext_IsaenextWebPortlet_label: lineId,
      }),
    );

    const observedAt = new Date().toISOString();
    return {
      lineId,
      observedAt,
      vehicles: rawVehicles.map((vehicle) => ({
        vehicleId: String(vehicle.id),
        lineId,
        routeId: vehicle.ruta == null ? null : String(vehicle.ruta),
        lat: vehicle.lat,
        lng: vehicle.lng,
        headingDegrees: null,
        offsetSeconds:
          typeof vehicle.desfaseTiempo === "number" ? vehicle.desfaseTiempo : null,
        offsetMeters:
          typeof vehicle.desfaseEspacio === "number" ? vehicle.desfaseEspacio : null,
        observedAt,
        source: "isaenext",
      })),
    };
  });
}

export async function getStopLinesIndex(): Promise<Map<string, Line[]>> {
  return withCache("stop-line-index", ROUTE_TTL_MS, async () => {
    const lines = await getLines();
    const entries = await Promise.all(
      lines.map(async (line) => ({
        line,
        routes: await getRoutesByLine(line.id),
      })),
    );

    const index = new Map<string, Line[]>();

    for (const entry of entries) {
      const seenStops = new Set<string>();

      for (const route of entry.routes) {
        for (const stop of route.stops) {
          if (seenStops.has(stop.id)) {
            continue;
          }

          seenStops.add(stop.id);
          const current = index.get(stop.id) ?? [];
          current.push(entry.line);
          current.sort((a, b) => a.publicCode.localeCompare(b.publicCode, "es"));
          index.set(stop.id, current);
        }
      }
    }

    return index;
  });
}

export async function getStopArrivals(stopId: string): Promise<StopArrivalsResponse> {
  const [stops, stopLineIndex] = await Promise.all([getAllStops(), getStopLinesIndex()]);
  const stop = stops.find((item) => item.id === stopId);

  if (!stop) {
    throw new Error(`Stop ${stopId} not found`);
  }

  const observedAt = new Date().toISOString();
  const rawNodes = await fetchJson<RawEstimationNode[]>(
    buildResourceUrl("resourceEstimations", {
      _as_asac_isaenext_IsaenextWebPortlet_tipo: String(stop.type ?? 1),
      _as_asac_isaenext_IsaenextWebPortlet_nodoIds: stopId,
    }),
  );

  const arrivals: ArrivalPrediction[] = [];
  for (const node of rawNodes) {
    for (const route of node.routeEstimationByNode) {
      for (const estimate of route.publicEstimationVHExts) {
        arrivals.push({
          stopId: node.nodoId,
          lineId: route.line,
          destination: route.destination,
          vehicleId: estimate.vehicle == null ? null : String(estimate.vehicle),
          etaSeconds: Number(estimate.seconds),
          distanceMeters:
            typeof estimate.meters === "number" ? estimate.meters : null,
          isLastBus:
            typeof estimate.isLastBus === "boolean" ? estimate.isLastBus : null,
          isPartialTrip:
            typeof estimate.isPartialTrip === "boolean"
              ? estimate.isPartialTrip
              : null,
          observedAt,
          source: "isaenext",
        });
      }
    }
  }

  arrivals.sort((a, b) => a.etaSeconds - b.etaSeconds);

  return {
    stop,
    lines: stopLineIndex.get(stopId) ?? [],
    arrivals,
    observedAt,
  };
}

export async function getNearbyStops(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<NearbyStopsResponse> {
  const [stops, stopLineIndex] = await Promise.all([getAllStops(), getStopLinesIndex()]);
  const origin = { lat, lng };
  const observedAt = new Date().toISOString();

  const nearbyStops = stops
    .map((stop) => ({
      stop,
      lines: stopLineIndex.get(stop.id) ?? [],
      distanceMeters: Math.round(haversineDistanceMeters(origin, stop)),
    }))
    .filter((item) => item.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 25);

  return {
    origin: {
      lat,
      lng,
      radiusMeters,
    },
    stops: nearbyStops,
    observedAt,
  };
}
