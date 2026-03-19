import { NextResponse } from "next/server";

import { getNearbyStops } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

const DEFAULT_RADIUS_METERS = 1000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const lat = Number(searchParams.get("lat"));
    const lng = Number(searchParams.get("lng"));
    const radiusMeters = Number(searchParams.get("radius") ?? DEFAULT_RADIUS_METERS);

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

    const data = await getNearbyStops(lat, lng, radiusMeters);
    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error);
  }
}
