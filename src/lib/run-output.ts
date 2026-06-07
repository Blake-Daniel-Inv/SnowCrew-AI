import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

const MAX_RENDERED_CHARS = 200_000;

export function extractCleanRunOutput(output: string): string {
  const stripped = stripAnsi(output || '').trim();
  if (!stripped) return '';

  const marker = '===== FINAL OUTPUT =====';
  const markerIndex = stripped.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return stripped.slice(markerIndex + marker.length).trim();
  }

  const finalAnswerIndex = stripped.lastIndexOf('Final Answer:');
  if (finalAnswerIndex >= 0) {
    return stripped.slice(finalAnswerIndex + 'Final Answer:'.length).trim();
  }

  return '';
}

// GFM keeps tables, strikethrough, autolinks. `breaks: false` matches
// standard markdown — newlines inside a paragraph stay soft. Sanitization
// is layered separately via DOMPurify; we don't trust marked alone.
marked.setOptions({ gfm: true, breaks: false });

let relHookInstalled = false;
function ensureRelHook(): void {
  if (relHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      // Force noopener/noreferrer on every link so reverse-tabnabbing is
      // impossible regardless of whether marked emitted target="_blank".
      node.setAttribute('rel', 'noopener noreferrer');
    }
    for (const attr of ['colspan', 'rowspan']) {
      const raw = node.getAttribute(attr);
      if (raw == null) continue;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        node.removeAttribute(attr);
        continue;
      }
      if (parsed > 64) node.setAttribute(attr, '64');
    }
  });
  relHookInstalled = true;
}

export const SAFE_HTML_TAGS = [
  'a', 'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
  'code', 'pre', 'kbd', 'mark',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div',
] as const;

export function sanitizeHtml(rawHtml: string): string {
  ensureRelHook();
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [...SAFE_HTML_TAGS],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'colspan', 'rowspan', 'align'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'svg', 'math', 'iframe', 'object', 'embed', 'script', 'base', 'meta', 'link'],
    FORBID_ATTR: ['style', 'id', 'class', 'srcset', 'formaction', 'xmlns'],
  });
}

/**
 * Render markdown to HTML safe enough for both in-app display and email.
 * Pipeline: marked -> DOMPurify (allowlist).
 *
 * The allowlist is intentionally narrow — agents can return arbitrary
 * markdown, and we want tables/links/code/lists but no scripts, iframes,
 * or event handlers ever.
 */
export function markdownToSafeHtml(markdown: string): string {
  const cleaned = stripAnsi(markdown || '');
  if (!cleaned.trim()) return '';

  const capped = cleaned.length > MAX_RENDERED_CHARS
    ? cleaned.slice(0, MAX_RENDERED_CHARS) + '\n\n*(output truncated)*'
    : cleaned;

  const rawHtml = marked.parse(capped, { async: false }) as string;
  return sanitizeHtml(rawHtml);
}
