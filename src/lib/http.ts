import { NextResponse } from "next/server";

export function handleApiError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unexpected internal error";

  return NextResponse.json(
    {
      error: message,
    },
    {
      status: 500,
    },
  );
}
