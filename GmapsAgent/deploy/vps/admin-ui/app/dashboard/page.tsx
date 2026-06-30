import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="wrap">
      <h1 style={{ marginBottom: "0.25rem" }}>API keys</h1>
      <p className="sub" style={{ marginTop: 0 }}>
        Paste keys into the Maps extension (enrich settings). Table loads below — if it stays empty, check DevTools → Network and API container logs.
      </p>
      <DashboardClient />
    </div>
  );
}
