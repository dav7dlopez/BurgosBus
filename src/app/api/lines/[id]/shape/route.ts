import { NextResponse } from "next/server";

import { getLineShape } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const data = await getLineShape(id);
    return NextResponse.json(data);
  } catch (error) {
    return handleApiError(error);
  }
}
