import { h } from 'preact';
import htm from 'htm';
import type { GmailLabel } from '../types.js';

const html = htm.bind(h);

interface SidebarProps {
  labels: GmailLabel[];
  activeLabel: string;
  useGmailLabelColors: boolean;
  onLabelClick: (labelId: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ labels, activeLabel, useGmailLabelColors, onLabelClick, isOpen, onClose }: SidebarProps) {
  const userLabels = labels
    .filter(l => l.type === 'user')
    .sort((a, b) => a.name.localeCompare(b.name));

  if (userLabels.length === 0) return null;

  return html`
    <aside class="sidebar ${isOpen ? 'open' : ''}">
      <div class="sidebar-header">labels</div>
      <div class="sidebar-list">
        ${userLabels.map(label => {
          const useColor = useGmailLabelColors && label.color;
          const style = useColor
            ? `color: ${label.color!.textColor || 'inherit'}; background: ${label.color!.backgroundColor || 'transparent'};`
            : '';
          return html`
            <button
              key=${label.id}
              class="sidebar-label ${label.id === activeLabel ? 'active' : ''}"
              style=${style}
              onClick=${() => { onLabelClick(label.id); onClose(); }}
              title=${label.name}
            >
              <span class="sidebar-label-name">${label.name}</span>
              ${label.messagesUnread ? html`<span class="sidebar-label-count">${label.messagesUnread}</span>` : ''}
            </button>
          `;
        })}
      </div>
    </aside>
  `;
}
