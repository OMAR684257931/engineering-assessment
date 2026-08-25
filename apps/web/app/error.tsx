"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  // The underlying error is intentionally not rendered: it may reference
  // internal services. It is still reported to the server console by Next.js.
  return (
    <main className="page-shell">
      <div className="page-title">
        <div>
          <h1>Something went wrong</h1>
          <p className="application-id">
            We could not load this application right now.
          </p>
        </div>
      </div>
      <section className="summary">
        <button type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
