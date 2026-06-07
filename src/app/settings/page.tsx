/**
 * /settings — top-level integrations page. Server component so the
 * initial HTML ships with the page shell painted; the client-side
 * `IntegrationsPanel` handles fetching and interactive bits.
 *
 * The GitHub OAuth callback (src/app/api/auth/github/callback) redirects
 * here with `?integration=github&status=...` query params. The client
 * panel reads those, shows the matching toast, then clears them via
 * router.replace so a back-button-then-forward doesn't re-fire the toast.
 */
import { Suspense } from 'react';
import Link from 'next/link';
import { IntegrationsPanel } from '@/components/IntegrationsPanel';

export const metadata = {
  title: 'Settings — CrewAI Studio',
};

// Force dynamic so the page doesn't get statically pre-rendered with
// stale query-param assumptions. The panel is `'use client'` anyway,
// but flipping this prevents Next from emitting a `force-static`
// optimization that some build profiles try.
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <h1 className="settings-page-title">Settings</h1>
        <Link href="/" className="settings-page-back" aria-label="Back to Studio">
          ← Back to Studio
        </Link>
      </header>
      <main className="settings-page-body">
        <h2 className="settings-section-title">Integrations</h2>
        {/* useSearchParams() inside IntegrationsPanel needs to be
          * mounted under a Suspense boundary to render correctly on the
          * App Router. The fallback echoes the panel's loading skeleton so
          * users never see a flash of nothing while the client hydrates. */}
        <Suspense
          fallback={
            <div
              className="integrations-skeleton"
              aria-busy="true"
              aria-label="Loading integrations"
            />
          }
        >
          <IntegrationsPanel />
        </Suspense>
      </main>
    </div>
  );
}
