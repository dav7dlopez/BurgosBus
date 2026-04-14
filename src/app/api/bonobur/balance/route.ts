import { NextResponse } from "next/server";

const BONOBUR_UPSTREAM_BALANCE_URL =
  "https://bonobur.aytoburgos.es:8443/api/cargasaldo/comprobar";
const BONOBUR_TIMEOUT_MS = 7000;

type UpstreamBalancePayload = {
  respuesta?: unknown;
  error?: unknown;
  Message?: unknown;
  saldo?: unknown;
  vigencia?: unknown;
  recargaPendiente?: unknown;
  fechaRecargaPendiente?: unknown;
};

function normalizeCardNumber(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, "");
}

function toNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function POST(request: Request) {
  let payload: { numeroTarjeta?: unknown } | null = null;

  try {
    payload = (await request.json()) as { numeroTarjeta?: unknown };
  } catch {
    return NextResponse.json(
      {
        ok: false,
        status: "functional_error",
        message: "Solicitud inválida para consultar saldo BONOBUR.",
      },
      { status: 400 },
    );
  }

  const numeroTarjeta = normalizeCardNumber(payload?.numeroTarjeta);
  if (!/^\d{10,13}$/.test(numeroTarjeta)) {
    return NextResponse.json(
      {
        ok: false,
        status: "functional_error",
        message: "Introduce un número de tarjeta válido (solo dígitos).",
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BONOBUR_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(BONOBUR_UPSTREAM_BALANCE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
      body: JSON.stringify({ numeroTarjeta }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: "technical_error",
          message: "Servicio BONOBUR temporalmente no disponible.",
        },
        { status: 503 },
      );
    }

    const upstreamData = (await upstreamResponse.json()) as UpstreamBalancePayload;
    const functionalError =
      toNullableString(upstreamData.error) ?? toNullableString(upstreamData.Message);

    if (upstreamData.respuesta === -1 || functionalError) {
      return NextResponse.json(
        {
          ok: false,
          status: "functional_error",
          message:
            functionalError ??
            "No se ha podido validar la tarjeta BONOBUR en este momento.",
        },
        { status: 200 },
      );
    }

    const saldoCents = toNullableNumber(upstreamData.saldo);
    const recargaPendienteCents = toNullableNumber(upstreamData.recargaPendiente);
    const observedAt = new Date().toISOString();

    return NextResponse.json(
      {
        ok: true,
        status: "success",
        observedAt,
        balanceEuros: saldoCents !== null ? saldoCents / 100 : null,
        validity: toNullableString(upstreamData.vigencia),
        pendingTopUpEuros:
          recargaPendienteCents !== null ? recargaPendienteCents / 100 : null,
        pendingTopUpDate: toNullableString(upstreamData.fechaRecargaPendiente),
      },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        status: "technical_error",
        message: "Servicio BONOBUR temporalmente no disponible.",
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

