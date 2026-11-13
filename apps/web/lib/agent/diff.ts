export interface PromptSectionDiff {
  key: string;
  before: string;
  after: string;
  change: 'added' | 'changed' | 'removed';
}

export function diffPromptSections(before: Record<string, string>, after: Record<string, string>): PromptSectionDiff[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key): PromptSectionDiff[] => {
      const previous = before[key] ?? '';
      const next = after[key] ?? '';
      if (previous === next) return [];
      return [{key, before: previous, after: next, change: previous ? (next ? 'changed' : 'removed') : 'added'}];
    });
}
