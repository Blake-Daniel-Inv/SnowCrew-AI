// tasks.yaml emitter for CrewStudio export bundle.

import type { CrewStudioWorkspace } from '@/types';
import { filterAcyclicContextTaskIds, sanitizeIdentifier, yamlBlock } from '../normalize';

export function buildTasksYaml(workspace: CrewStudioWorkspace): string {
  return workspace.tasks
    .map((task) => {
      const safeContextIds = filterAcyclicContextTaskIds(workspace, task);
      const contextLines = safeContextIds.length
        ? `\n  context:\n${safeContextIds
            .map((taskId) => workspace.tasks.find((candidate) => candidate.id === taskId))
            .filter(Boolean)
            .map((candidate) => `    - ${sanitizeIdentifier(candidate!.name, 'task')}`)
            .join('\n')}`
        : '';
      const outputFileLine = task.outputFile
        ? `\n  output_file: ${JSON.stringify(task.outputFile)}`
        : '';

      return `${sanitizeIdentifier(task.name, 'task')}:
  description: >
${yamlBlock(task.description)}
  expected_output: >
${yamlBlock(task.expectedOutput)}
  agent: ${sanitizeIdentifier(
    workspace.agents.find((agent) => agent.id === task.agentId)?.name || 'unassigned_agent',
    'unassigned_agent'
  )}${contextLines}${outputFileLine}
  human_input: ${task.humanInput ? 'true' : 'false'}
  async_execution: ${task.asyncExecution ? 'true' : 'false'}
  markdown: ${task.markdown ? 'true' : 'false'}`;
    })
    .join('\n\n');
}
