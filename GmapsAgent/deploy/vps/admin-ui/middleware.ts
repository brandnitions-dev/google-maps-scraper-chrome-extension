import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname !== "/") {
    return NextResponse.next();
  }
  const tok = request.cookies.get("gms_admin");
  const url = request.nextUrl.clone();
  url.pathname = tok?.value ? "/dashboard" : "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: "/",
};
