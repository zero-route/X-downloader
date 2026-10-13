import { NextRequest, NextResponse } from "next/server";
import { ProviderError, fetchTweet, parseTarget } from "@/lib/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fail(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url")?.trim();

  if (!raw) {
    return fail("Masukkan tautan tweet terlebih dahulu.", 400);
  }

  const target = parseTarget(raw);

  if (!target) {
    return fail(
      "Tautan tidak valid. Gunakan tautan tweet, contoh: x.com/username/status/123...",
      400
    );
  }

  try {
    const data = await fetchTweet(target);

    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      return fail(error.message, error.status);
    }

    return fail(
      error instanceof Error ? error.message : "Gagal memproses tweet.",
      500
    );
  }
}
