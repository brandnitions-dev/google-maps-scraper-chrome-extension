import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

/** Server shell: visible without client JS (fixes blank white if chunks fail to load). */
export default function LoginPage() {
  return (
    <div className="wrap">
      <h1>Email enricher</h1>
      <p className="sub">Admin · API keys for the Maps extension</p>
      <LoginForm />
      <p className="sub" style={{ marginTop: "1.5rem", fontSize: "0.8rem" }}>
        If the form does not respond, open DevTools → Network: <code>/_next/static/</code> requests must return 200 (not blocked by a proxy).
      </p>
    </div>
  );
}
