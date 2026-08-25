import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-shell">
      <div className="page-title">
        <div>
          <h1>Application not available</h1>
          <p className="application-id">
            This application does not exist, or is not available for your
            account.
          </p>
        </div>
      </div>
      <section className="summary">
        <p>
          <Link href="/">Return to your application</Link>
        </p>
      </section>
    </main>
  );
}
