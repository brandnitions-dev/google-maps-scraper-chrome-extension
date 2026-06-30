/** Fallback if middleware is skipped. */
export default function HomePage() {
  return (
    <div className="wrap">
      <h1>Maps enrich admin</h1>
      <p className="sub">
        <a href="/login">Go to login</a> · <a href="/dashboard">Dashboard</a>
      </p>
    </div>
  );
}
