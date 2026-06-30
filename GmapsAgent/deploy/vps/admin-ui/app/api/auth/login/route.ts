import { NextResponse } from "next/server";

const API = process.env.API_INTERNAL_URL || "http://127.0.0.1:18765";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const r = await fetch(`${API}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return NextResponse.json(data, { status: r.status });
  }

  const token = (data as { access_token?: string }).access_token;
  const expiresIn =
    typeof (data as { expires_in?: number }).expires_in === "number"
      ? (data as { expires_in: number }).expires_in
      : 86400;

  if (!token) {
    return NextResponse.json({ error: "no_token" }, { status: 502 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("gms_admin", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: expiresIn,
  });
  return res;
}
