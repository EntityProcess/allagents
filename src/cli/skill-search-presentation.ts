import {
  qualifiedName,
  type InteractiveSkillSearchResult,
  type SkillSearchItem,
} from '../core/skill-search.js';

export interface SkillSearchPresentationRow {
  kind: 'heading' | 'status' | 'item';
  label: string;
  value: string;
  disabled: boolean;
  item?: SkillSearchItem;
}

export function skillSearchSelectionKey(item: SkillSearchItem): string {
  const identity = item.catalog?.identity ?? item.installSource.toLowerCase();
  return `${identity}#${item.repo.toLowerCase()}#${item.path}`;
}

/** Build stable, ordered rows shared by both interactive search surfaces. */
export function buildSkillSearchPresentationRows(
  result: InteractiveSkillSearchResult,
): SkillSearchPresentationRow[] {
  const rows: SkillSearchPresentationRow[] = [];
  const hasResults = result.sections.some((section) => section.items.length > 0);
  for (const section of result.sections) {
    rows.push({
      kind: 'heading',
      label: `── ${section.label} ──`,
      value: `__skill-search-section:${section.id}`,
      disabled: true,
    });

    if (section.error) {
      rows.push({
        kind: 'status',
        label: hasResults ? 'Unavailable — partial results shown' : 'Unavailable',
        value: `__skill-search-error:${section.id}`,
        disabled: true,
      });
      continue;
    }

    if (section.items.length === 0) {
      rows.push({
        kind: 'status',
        label: 'No matching skills',
        value: `__skill-search-empty:${section.id}`,
        disabled: true,
      });
      continue;
    }

    for (const item of section.items) {
      rows.push({
        kind: 'item',
        label: `${qualifiedName(item)}  ${item.repo}`,
        value: skillSearchSelectionKey(item),
        disabled:
          item.installation.policy === 'search-only' ||
          item.installation.policy === 'external-installer',
        item,
      });
    }
  }
  return rows;
}

export function findSkillSearchSelection(
  result: InteractiveSkillSearchResult,
  selectionKey: string,
): SkillSearchItem | undefined {
  for (const section of result.sections) {
    const item = section.items.find(
      (candidate) => skillSearchSelectionKey(candidate) === selectionKey,
    );
    if (item) return item;
  }
  return undefined;
}
