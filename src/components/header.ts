import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { StatusDot, formatBytes } from './common.js';
import type { ConnectionStatus } from '../types.js';

const html = htm.bind(h);

export interface WidthPreset {
  id: string;
  label: string;
  value: string;
}

export const WIDTH_PRESETS: WidthPreset[] = [
  { id: 'narrow', label: 'narrow', value: '800px' },
  { id: 'medium', label: 'medium', value: '1000px' },
  { id: 'wide',   label: 'wide',   value: '1200px' },
  { id: 'full',   label: 'full',   value: '100%' },
];

export const DEFAULT_WIDTH_ID = 'medium';

interface HeaderProps {
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  totalEmails: number;
  totalBytes: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  userEmail: string | null;
  onLogout: () => void;
  onRefresh: () => void;
  containerWidth: string;
  onSetContainerWidth: (id: string) => void;
  onCycleContainerWidth: () => void;
  showCategoryTabs: boolean;
  onToggleShowCategoryTabs: () => void;
  useGmailLabelColors: boolean;
  onToggleUseGmailLabelColors: () => void;
  headerCollapsed: boolean;
}

export function Header({ connectionStatus, unreadCount, totalEmails, totalBytes, theme, onToggleTheme, userEmail, onLogout, onRefresh, containerWidth, onSetContainerWidth, onCycleContainerWidth, showCategoryTabs, onToggleShowCategoryTabs, useGmailLabelColors, onToggleUseGmailLabelColors, headerCollapsed }: HeaderProps) {
  const [showAccount, setShowAccount] = useState(false);
  const [showWidth, setShowWidth] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const widthPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAccount) return;
    const close = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowAccount(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showAccount]);

  useEffect(() => {
    if (!showWidth) return;
    const close = (e: MouseEvent) => {
      if (widthPopoverRef.current && !widthPopoverRef.current.contains(e.target as Node)) {
        setShowWidth(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showWidth]);

  const currentPreset = WIDTH_PRESETS.find(p => p.id === containerWidth) ?? WIDTH_PRESETS.find(p => p.id === DEFAULT_WIDTH_ID)!;

  const statusText = connectionStatus === 'online' ? 'connected'
    : connectionStatus === 'slow' ? 'slow connection'
    : 'offline';

  const inboxText = totalEmails === 0
    ? 'inbox zero ʕᵔᴥᵔʔ'
    : `${unreadCount} unread`;

  return html`
    <header class="header ${headerCollapsed ? 'collapsed' : ''}">
      ${!headerCollapsed && html`
        <div class="header-brand">
          <div class="header-bear">ʕ·ᴥ·ʔ</div>
          <div class="header-wordmark">
            BAREMAIL
          </div>
          <div class="header-tagline">── email's bare necessities ──</div>
        </div>
      `}
      <div class="header-status">
        <span class="header-status-left" ref=${popoverRef}>
          <button class="header-status-btn" onClick=${() => setShowAccount(!showAccount)}>
            <${StatusDot} status=${connectionStatus} />
            ${statusText}
          </button>
          ${' · '}${inboxText}${' '}
          <button class="header-refresh-btn" onClick=${onRefresh} title="refresh inbox">↻</button>
          ${showAccount && html`
            <div class="account-popover">
              ${userEmail && html`
                <div class="account-popover-email">${userEmail}</div>
              `}
              <button class="account-popover-toggle" onClick=${onToggleShowCategoryTabs}>
                <span class="checkbox-glyph">${showCategoryTabs ? '[x]' : '[ ]'}</span> show category tabs
              </button>
              <button class="account-popover-toggle" onClick=${onToggleUseGmailLabelColors}>
                <span class="checkbox-glyph">${useGmailLabelColors ? '[x]' : '[ ]'}</span> use gmail label colors
              </button>
              <div class="account-popover-divider" />
              <button class="account-popover-logout" onClick=${onLogout}>
                ⏻ sign out
              </button>
            </div>
          `}
        </span>
        <span>
          <span class="width-control" ref=${widthPopoverRef}>
            <button class="width-cycle-btn" onClick=${onCycleContainerWidth} title="cycle width">
              ↔ ${currentPreset.label}
            </button>
            <button class="width-dropdown-btn" onClick=${() => setShowWidth(v => !v)} title="choose width">
              ▾
            </button>
            ${showWidth && html`
              <div class="width-popover">
                ${WIDTH_PRESETS.map(p => html`
                  <button
                    key=${p.id}
                    class="width-popover-option ${p.id === containerWidth ? 'active' : ''}"
                    onClick=${() => { onSetContainerWidth(p.id); setShowWidth(false); }}
                  >
                    <span>${p.label}</span>
                    ${p.label !== p.value && html`<span class="width-popover-hint">${p.value}</span>`}
                  </button>
                `)}
              </div>
            `}
          </span>
          ${' · '}
          <button class="theme-toggle" onClick=${onToggleTheme}>
            ${theme === 'dark' ? '◑ light' : '◐ dark'}
          </button>
          ${' · '}↓ ${formatBytes(totalBytes)} api
        </span>
      </div>
    </header>
  `;
}
