export type MapCenter = {
  lat: number;
  lng: number;
};

export type VectorStyleMapProvider = {
  id: string;
  name: string;
  kind: "vector-style";
  styleUrl: string;
  attribution: string;
  center: MapCenter;
  zoom: number;
  minZoom: number;
  maxZoom: number;
};

export const mapProviders = {
  openFreeMap: {
    id: "openfreemap-liberty",
    name: "OpenFreeMap Liberty",
    kind: "vector-style",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
    center: {
      lat: 42.343992,
      lng: -3.696906,
    },
    zoom: 13,
    minZoom: 11,
    maxZoom: 19,
  } satisfies VectorStyleMapProvider,
  developmentFallback: {
    id: "openfreemap-positron",
    name: "OpenFreeMap Positron",
    kind: "vector-style",
    styleUrl: "https://tiles.openfreemap.org/styles/positron",
    attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
    center: {
      lat: 42.343992,
      lng: -3.696906,
    },
    zoom: 13,
    minZoom: 11,
    maxZoom: 19,
  } satisfies VectorStyleMapProvider,
};

export const defaultMapProvider = mapProviders.openFreeMap;
