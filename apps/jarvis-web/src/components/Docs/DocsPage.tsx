export function DocsPage() {
  return (
    <main id="docs-page" className="docs-page" aria-label="Doc">
      <header className="docs-page-header">
        <h1>Doc</h1>
        <label className="docs-search" aria-label="Search wiki">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input type="search" placeholder="Search LLM Wiki" />
        </label>
        <button type="button" className="docs-new-btn">New page</button>
      </header>

      <section className="docs-empty" aria-live="polite">
        <div className="docs-empty-icon" aria-hidden="true">
          <svg width="70" height="70" viewBox="0 0 70 70" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 10h25l9 9v41H18z" />
            <path d="M42 10v11h10" />
            <path d="M26 32h18" />
            <path d="M26 40h18" />
            <path d="M26 48h12" />
          </svg>
        </div>
        <h2>LLM Wiki</h2>
        <p>Docs and reusable knowledge will live here.</p>
      </section>
    </main>
  );
}
