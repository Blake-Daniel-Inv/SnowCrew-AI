import path from 'path';
import type { NextConfig } from 'next';

/**
 * Content-Security-Policy applied globally.
 *
 * Why a single global value:
 *   - Defense in depth: every page (including future ones) inherits the
 *     same baseline without each route having to opt in.
 *   - Operationally simpler: one header value to audit, one place to
 *     update when a new external origin is needed.
 *
 * Why we still allow `'unsafe-inline'` for script and style:
 *   - Tailwind 4 + Next.js 16 inject inline `<style>` tags for CSS
 *     extraction, and Next emits a small inline `<script>` for
 *     hydration / chunk preloading. Removing `'unsafe-inline'` would
 *     require nonce-based CSP plumbed through every server component
 *     and the SSR renderer — that's a larger refactor flagged for a
 *     follow-up PR.
 *
 * Directive notes:
 *   - default-src 'self'                  — fallback for everything
 *     unlisted; everything else is intentionally restrictive.
 *   - script-src 'self' 'unsafe-inline'   — see above.
 *   - style-src  'self' 'unsafe-inline'   — see above.
 *   - img-src 'self' data:                — local images and inline
 *     data URLs. Includes `https://avatars.githubusercontent.com` for
 *     the GitHub avatar use case (not in the UI today but reserved
 *     so adding it later doesn't require a redeploy).
 *   - font-src 'self' data:               — local + data-URL fonts.
 *   - connect-src 'self' https://api.github.com https://*.snowflakecomputing.com
 *                                         — XHR/fetch destinations:
 *     same-origin always; GitHub API for any future browser-side
 *     diagnostics; Snowflake hosts for direct PUT/GET to stages if
 *     that ever happens.
 *   - form-action 'self' https://github.com — allows the OAuth flow's
 *     GitHub redirect to be initiated as a `<form>` POST should any
 *     code path use one. Today we use a server-side 302 from
 *     `/api/auth/github/start`, but we don't want to one-shot ourselves
 *     if someone adds a form later.
 *   - frame-ancestors 'none'              — complements X-Frame-Options
 *     DENY for browsers that prefer CSP over the legacy header.
 *   - base-uri 'self'                     — locks down `<base>` so an
 *     injected tag cannot rewrite relative URLs.
 *
 * Header value MUST be a single line — Next.js rejects newlines in
 * header values at build time.
 */
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.github.com https://*.snowflakecomputing.com",
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ') + ';';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  serverExternalPackages: [
    // Native binding — webpack must not try to bundle the .node file.
    'better-sqlite3',
    // DOMPurify dynamically requires jsdom in Node; bundling breaks it.
    'isomorphic-dompurify',
    'marked',
    // pino uses dynamic require + worker threads in some transport modes.
    // Even though we don't use those transports today, mark it external so
    // webpack doesn't try to inline the runtime and choke on the dynamic
    // imports.
    'pino',
  ],
  experimental: {
    optimizePackageImports: ['@xyflow/react'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: CSP_VALUE },
        ],
      },
    ];
  },
};

export default nextConfig;
