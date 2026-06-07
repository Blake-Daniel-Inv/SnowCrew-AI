'use client';

import type { ValidationIssue } from '@/types';
import type { SelectedEntity } from './NodeConfigPanel';

export function ValidationPanel({
  issues,
  onFocus,
}: {
  issues: ValidationIssue[];
  onFocus: (target: SelectedEntity) => void;
}) {
  const counts = issues.reduce(
    (acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] || 0) + 1 }),
    {} as Record<string, number>
  );

  if (issues.length === 0) {
    return (
      <div className="validation-panel">
        <div className="validation-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="validation-empty-text">All checks passed</div>
          <div className="validation-empty-sub">This workspace looks ready to run</div>
        </div>
      </div>
    );
  }

  return (
    <div className="validation-panel">
      <div className="validation-summary">
        {counts.error ? <span className="validation-count validation-count-error">{counts.error} error{counts.error > 1 ? 's' : ''}</span> : null}
        {counts.warning ? <span className="validation-count validation-count-warning">{counts.warning} warning{counts.warning > 1 ? 's' : ''}</span> : null}
        {counts.info ? <span className="validation-count validation-count-info">{counts.info} info</span> : null}
      </div>
      <div className="validation-list">
        {issues.map((issue) => (
          <button
            key={issue.id}
            type="button"
            className={`validation-item validation-${issue.severity}`}
            onClick={() => issue.target && onFocus(issue.target as SelectedEntity)}
            disabled={!issue.target}
          >
            <SeverityIcon severity={issue.severity} />
            <div className="validation-item-body">
              <div className="validation-item-message">
                <span className="sr-only">{issue.severity}: </span>
                {issue.message}
              </div>
              <div className="validation-item-meta">
                {issue.target ? `${issue.target.kind}` : 'workspace'} · {issue.code}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SeverityIcon({ severity }: { severity: ValidationIssue['severity'] }) {
  if (severity === 'error') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    );
  }
  if (severity === 'warning') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
