import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API = process.env.API_INTERNAL_URL || "http://127.0.0.1:18765";

function tokenFrom(req: NextRequest) {
  return req.cookies.get("gms_admin")?.value;
}

export async function GET(req: NextRequest) {
  const token = tokenFrom(req);
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await fetch(`${API}/admin/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({}));
  return NextResponse.json(data, { status: r.status });
}

export async function POST(req: NextRequest) {
  const token = tokenFrom(req);
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const r = await fetch(`${API}/admin/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return NextResponse.json(data, { status: r.status });
}
