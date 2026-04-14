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

function maskCardForLogs(cardNumber: string) {
  const safeDigits = cardNumber.replace(/[^\d]/g, "");
  const tail = safeDigits.slice(-4).padStart(4, "*");
  return `****${tail}`;
}

function getBodySnippet(body: string, maxLength = 220) {
  return body.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function getErrorDiagnostics(error: unknown) {
  const fallback = {
    name: "UnknownError",
    message: "Unknown error",
    causeCode: undefined as string | undefined,
    kind: "internal_exception",
  };

  if (!(error instanceof Error)) {
    return fallback;
  }

  const causeCode =
    typeof (error as Error & { cause?: { code?: unknown } }).cause?.code === "string"
      ? ((error as Error & { cause?: { code?: string } }).cause?.code as string)
      : undefined;

  const messageLower = error.message.toLowerCase();
  let kind = "internal_exception";

  if (error.name === "AbortError") {
    kind = "timeout_abort";
  } else if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN") {
    kind = "dns_error";
  } else if (
    causeCode?.startsWith("CERT_") ||
    causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    causeCode === "SELF_SIGNED_CERT_IN_CHAIN" ||
    causeCode === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    messageLower.includes("certificate")
  ) {
    kind = "tls_error";
  } else if (
    causeCode === "ECONNREFUSED" ||
    causeCode === "ECONNRESET" ||
    causeCode === "EHOSTUNREACH" ||
    causeCode === "ENETUNREACH" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    kind = "connection_or_port_error";
  }

  return {
    name: error.name,
    message: error.message,
    causeCode,
    kind,
  };
}

export async function POST(request: Request) {
  const requestId = `bonobur-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const routeStartedAt = Date.now();
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
  const maskedCard = maskCardForLogs(numeroTarjeta);
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
    const upstreamStartedAt = Date.now();
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
    const upstreamDurationMs = Date.now() - upstreamStartedAt;
    const upstreamBody = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      console.error("[BONOBUR] upstream non-2xx", {
        requestId,
        maskedCard,
        durationMs: Date.now() - routeStartedAt,
        upstreamDurationMs,
        upstreamStatus: upstreamResponse.status,
        upstreamStatusText: upstreamResponse.statusText,
        upstreamBodySnippet: getBodySnippet(upstreamBody),
      });
      return NextResponse.json(
        {
          ok: false,
          status: "technical_error",
          message: "Servicio BONOBUR temporalmente no disponible.",
        },
        { status: 503 },
      );
    }

    let upstreamData: UpstreamBalancePayload;
    try {
      upstreamData = JSON.parse(upstreamBody) as UpstreamBalancePayload;
    } catch (error) {
      const diagnostics = getErrorDiagnostics(error);
      console.error("[BONOBUR] upstream parse error", {
        requestId,
        maskedCard,
        durationMs: Date.now() - routeStartedAt,
        upstreamDurationMs,
        upstreamStatus: upstreamResponse.status,
        upstreamStatusText: upstreamResponse.statusText,
        errorName: diagnostics.name,
        errorMessage: diagnostics.message,
        errorCauseCode: diagnostics.causeCode,
        errorKind: "upstream_response_unparseable",
        upstreamBodySnippet: getBodySnippet(upstreamBody),
      });
      throw error;
    }

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
  } catch (error) {
    const diagnostics = getErrorDiagnostics(error);
    console.error("[BONOBUR] route technical error", {
      requestId,
      maskedCard,
      durationMs: Date.now() - routeStartedAt,
      errorName: diagnostics.name,
      errorMessage: diagnostics.message,
      errorCauseCode: diagnostics.causeCode,
      errorKind: diagnostics.kind,
    });
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
