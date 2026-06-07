// Post-run email action dispatcher — delegates timeouts/AbortController to snowflake-email.

import { sendRunActionEmail } from '@/lib/snowflake-email';
import { writeAuditEvent } from '@/lib/audit';
import type { CrewRun, CrewStudioCrew, CrewStudioWorkspace, TraceEvent } from '@/types';

export type EmailActionEmitEvent = (
  ev: Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'>
) => void;

export async function executeEmailActions(
  run: CrewRun,
  workspace: CrewStudioWorkspace,
  crew: CrewStudioCrew,
  emitEvent: EmailActionEmitEvent
): Promise<void> {
  // An action with afterTaskId set should only fire when that task was
  // actually part of the crew that ran. Actions with afterTaskId=null
  // fall back to firing after any successful run (workspace-wide hook).
  const crewTaskIds = new Set(crew.taskIds);
  const actions = workspace.actions.filter((action) => {
    if (!action.enabled || action.type !== 'email') return false;
    if (!action.afterTaskId) return true;
    return crewTaskIds.has(action.afterTaskId);
  });
  for (const action of actions) {
    emitEvent({
      type: 'log',
      title: `Sending email action "${action.name}"`,
      nodeId: action.id,
      phase: 'running',
    });

    try {
      const result = await sendRunActionEmail({ workspace, run, action });
      emitEvent({
        type: result.ok ? 'log' : 'warning',
        title: result.ok ? `Email action "${action.name}" sent` : `Email action "${action.name}" failed`,
        detail: result.message,
        nodeId: action.id,
        phase: result.ok ? 'completed' : 'failed',
      });
      if (result.ok) {
        // Audit AFTER the send succeeds. We record recipient count
        // (not the addresses — those would be PHI under HIPAA) and
        // the subject line ONLY. The body is never recorded.
        writeAuditEvent({
          ownerId: run.ownerId,
          action: 'email.sent',
          targetType: 'run',
          targetId: run.id,
          metadata: {
            actionId: action.id,
            actionName: action.name,
            recipientCount: action.recipients?.length ?? 0,
            subject: action.subject || '',
          },
        });
      }
    } catch (error) {
      emitEvent({
        type: 'warning',
        title: `Email action "${action.name}" failed`,
        detail: error instanceof Error ? error.message : String(error),
        nodeId: action.id,
        phase: 'failed',
      });
    }
  }
}
