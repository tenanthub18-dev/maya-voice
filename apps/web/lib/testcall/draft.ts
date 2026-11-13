import type {AgentVersion, DataSource} from '@/lib/data';
import type {PromptChangeProposal} from './transport';

export async function acceptPromptProposal(
  source: DataSource,
  draftId: string,
  proposal: PromptChangeProposal,
): Promise<AgentVersion> {
  const draft = (await source.listAgentVersions()).find((version) => version.id === draftId && version.status === 'draft');
  if (!draft || draft.promptSections[proposal.section] !== proposal.before) {
    throw new Error('STALE_TEST_CALL_DRAFT');
  }
  const revision = await source.restoreAgentVersion(draft.id);
  return source.saveAgentDraft(
    revision.agentId,
    {...revision.promptSections, [proposal.section]: proposal.after},
    revision.voices,
    revision.rules,
  );
}
