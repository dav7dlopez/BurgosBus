import { NextResponse } from "next/server";

import { getNearbyStops } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

const DEFAULT_RADIUS_METERS = 1000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const lat = Number(searchParams.get("lat"));
    const lng = Number(searchParams.get("lng"));
    const radiusParam = searchParams.get("radius");
    const radiusMeters =
      radiusParam === null ? DEFAULT_RADIUS_METERS : Number(radiusParam);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        {
          error: "lat y lng son obligatorios",
        },
        {
          status: 400,
        },
      );
    }

    if (radiusParam !== null && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
      return NextResponse.json(
        {
          error: "radius debe ser un numero mayor que 0",
        },
        {
          status: 400,
        },
      );
    }

    const data = await getNearbyStops(lat, lng, radiusMeters);
    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error);
  }
}
