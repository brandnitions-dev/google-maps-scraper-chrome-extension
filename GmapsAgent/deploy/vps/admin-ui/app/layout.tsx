import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maps enrich · Admin",
  description: "API keys for email enricher",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <noscript>
          <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f1419", color: "#e7eef8", minHeight: "100vh" }}>
            <p>JavaScript is required for sign-in.</p>
            <p>
              <a href="/login" style={{ color: "#5b8def" }}>
                Open login
              </a>
            </p>
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
