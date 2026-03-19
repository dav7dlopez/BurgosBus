import { NextResponse } from "next/server";

import { getStopArrivals } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const data = await getStopArrivals(id);
    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error);
  }
}
