import { NextResponse } from "next/server";

import { getLineDetail } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const line = await getLineDetail(id);
    return NextResponse.json(line);
  } catch (error) {
    return handleApiError(error);
  }
}
