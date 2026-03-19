import { NextResponse } from "next/server";

import { getLines } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET() {
  try {
    const lines = await getLines();
    return NextResponse.json(lines);
  } catch (error) {
    return handleApiError(error);
  }
}
