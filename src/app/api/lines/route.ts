import { NextResponse } from "next/server";

import { getLinesWithActivity } from "@/lib/burgos-provider";
import { handleApiError } from "@/lib/http";

export async function GET() {
  try {
    const lines = await getLinesWithActivity();
    return NextResponse.json(lines);
  } catch (error) {
    return handleApiError(error);
  }
}
