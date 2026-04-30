import { h } from 'preact';
import htm from 'htm';
import type { View, GmailLabel } from '../types.js';

const html = htm.bind(h);

const CATEGORY_ORDER = [
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

const CATEGORY_DISPLAY: Record<string, { name: string; icon: string }> = {
  CATEGORY_PERSONAL:   { name: 'personal',   icon: '@' },
  CATEGORY_SOCIAL:     { name: 'social',     icon: '◉' },
  CATEGORY_PROMOTIONS: { name: 'promotions', icon: '%' },
  CATEGORY_UPDATES:    { name: 'updates',    icon: 'i' },
  CATEGORY_FORUMS:     { name: 'forums',     icon: '#' },
};

// Map our friendly tab ids to Gmail label ids for unread-count lookup.
const TAB_TO_LABEL_ID: Record<string, string> = {
  inbox:   'INBOX',
  starred: 'STARRED',
  sent:    'SENT',
  drafts:  'DRAFT',
};

interface NavProps {
  activeLabel: string;
  view: View;
  searchQuery: string;
  apiSearchQuery: string;
  onTabClick: (tab: string) => void;
  onSearchInput: (q: string) => void;
  onSearchSubmit: () => void;
  onSearchClear: () => void;
  onCompose: () => void;
  labels: GmailLabel[];
  showCategoryTabs: boolean;
}

export function Nav({ activeLabel, view, searchQuery, apiSearchQuery, onTabClick, onSearchInput, onSearchSubmit, onSearchClear, onCompose, labels, showCategoryTabs }: NavProps) {
  const labelById = new Map(labels.map(l => [l.id, l]));

  // Show the Gmail label's unread / total counts — both numbers come from
  // the labels API so they include items the app hasn't loaded yet.
  const countLabel = (tabId: string) => {
    const labelId = TAB_TO_LABEL_ID[tabId] || tabId;
    const label = labelById.get(labelId);
    if (!label) return '';
    const unread = label.messagesUnread ?? 0;
    const total = label.messagesTotal ?? 0;
    if (!total) return '';
    return ` (${unread}/${total})`;
  };

  const tabs: Array<{ id: string; label: string; icon: string }> = [
    { id: 'inbox',   label: `inbox${countLabel('inbox')}`,     icon: '>' },
    { id: 'starred', label: `starred${countLabel('starred')}`, icon: '★' },
    { id: 'sent',    label: `sent${countLabel('sent')}`,       icon: '↑' },
    { id: 'drafts',  label: `drafts${countLabel('drafts')}`,   icon: '◫' },
  ];

  if (showCategoryTabs) {
    const categoryLabels = labels
      .filter(l => l.type === 'system' && CATEGORY_DISPLAY[l.id])
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id));
    for (const cat of categoryLabels) {
      const display = CATEGORY_DISPLAY[cat.id];
      tabs.push({ id: cat.id, label: `${display.name}${countLabel(cat.id)}`, icon: display.icon });
    }
  }

  tabs.push({ id: 'compose', label: 'compose', icon: '+' });

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchSubmit();
      (e.target as HTMLInputElement).blur();
    }
  };

  return html`
    <nav class="nav">
      ${tabs.map(tab => html`
        <button
          key=${tab.id}
          class="nav-tab ${(activeLabel === tab.id && view !== 'compose') || (tab.id === 'compose' && view === 'compose') ? 'active' : ''}"
          onClick=${() => tab.id === 'compose' ? onCompose() : onTabClick(tab.id)}
        >
          <span class="nav-tab-icon">${tab.icon}</span>
          ${tab.label}
        </button>
      `)}
      <div class="nav-spacer" />
      ${view === 'inbox' && html`
        <div class="nav-search ${apiSearchQuery ? 'active-search' : ''}">
          <span class="nav-search-icon">⌕</span>
          <input
            type="text"
            placeholder="search..."
            value=${searchQuery}
            onInput=${(e: Event) => onSearchInput((e.target as HTMLInputElement).value)}
            onKeyDown=${handleSearchKeyDown}
          />
          ${(searchQuery || apiSearchQuery) && html`
            <button class="nav-search-clear" onClick=${onSearchClear}>✕</button>
          `}
        </div>
      `}
    </nav>
  `;
}
