import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API = process.env.API_INTERNAL_URL || "http://127.0.0.1:18765";

export async function DELETE(
  req: NextRequest,
  ctx: { params: { id: string } }
) {
  const token = req.cookies.get("gms_admin")?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = encodeURIComponent(ctx.params.id);
  const r = await fetch(`${API}/admin/api-keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json().catch(() => ({}));
  return NextResponse.json(data, { status: r.status });
}
