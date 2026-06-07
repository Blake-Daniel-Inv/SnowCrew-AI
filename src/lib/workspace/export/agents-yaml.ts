// agents.yaml emitter for CrewStudio export bundle.

import type { CrewStudioWorkspace } from '@/types';
import { sanitizeIdentifier, yamlBlock } from '../normalize';

export function buildAgentsYaml(workspace: CrewStudioWorkspace): string {
  return workspace.agents
    .map((agent) => {
      // Note: we deliberately don't emit `tools:` or `knowledge_sources:`
      // in agents.yaml.
      // - `tools`: CrewAI's @CrewBase resolves YAML names to @tool-decorated
      //   methods on the class; ours come from `Agent(tools=...)` in crew.py.
      //   This includes the `github` tool AND the PR-20 sub-crew tools:
      //   when an agent declares `subCrewToolIds`, crew-py.ts emits
      //   `tools=self._subcrew_tools_for(...)` on the corresponding @agent
      //   factory. No YAML change is needed for either category.
      // - `knowledge_sources`: must be BaseKnowledgeSource instances/dicts,
      //   not bare strings. The Studio stores these as descriptive notes for
      //   the user; they're not wired into CrewAI as real knowledge.
      return `${sanitizeIdentifier(agent.name, 'agent')}:
  role: >
${yamlBlock(agent.role)}
  goal: >
${yamlBlock(agent.goal)}
  backstory: >
${yamlBlock(agent.backstory)}
  llm: ${JSON.stringify(agent.llm)}
  allow_delegation: ${agent.allowDelegation ? 'true' : 'false'}
  verbose: ${agent.verbose ? 'true' : 'false'}
  max_iter: ${agent.maxIter}`;
    })
    .join('\n\n');
}
