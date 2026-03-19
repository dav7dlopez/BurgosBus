import { NextResponse } from "next/server";

import { getLineStops } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const data = await getLineStops(id);
    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error);
  }
}
