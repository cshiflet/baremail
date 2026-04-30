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
  onToggleHeaderCollapsed: () => void;
  footerEnabled: boolean;
  onToggleFooterEnabled: () => void;
  footerText: string;
  onSetFooterText: (text: string) => void;
  showSidebar: boolean;
  onToggleShowSidebar: () => void;
  inboxLabelMode: 'hidden' | 'hover' | 'always';
  onSetInboxLabelMode: (mode: 'hidden' | 'hover' | 'always') => void;
  conversationMode: boolean;
  onToggleConversationMode: () => void;
  inboxScrollMode: 'manual' | 'auto';
  onSetInboxScrollMode: (mode: 'manual' | 'auto') => void;
}

export function Header({ connectionStatus, unreadCount, totalEmails, totalBytes, theme, onToggleTheme, userEmail, onLogout, onRefresh, containerWidth, onSetContainerWidth, onCycleContainerWidth, showCategoryTabs, onToggleShowCategoryTabs, useGmailLabelColors, onToggleUseGmailLabelColors, headerCollapsed, onToggleHeaderCollapsed, footerEnabled, onToggleFooterEnabled, footerText, onSetFooterText, showSidebar, onToggleShowSidebar, inboxLabelMode, onSetInboxLabelMode, conversationMode, onToggleConversationMode, inboxScrollMode, onSetInboxScrollMode }: HeaderProps) {
  const [showAccount, setShowAccount] = useState(false);
  const [showWidth, setShowWidth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const widthPopoverRef = useRef<HTMLDivElement>(null);
  const settingsPopoverRef = useRef<HTMLSpanElement>(null);

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

  useEffect(() => {
    if (!showSettings) return;
    const close = (e: MouseEvent) => {
      if (settingsPopoverRef.current && !settingsPopoverRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showSettings]);

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
              <button class="account-popover-logout" onClick=${onLogout}>
                ⏻ sign out
              </button>
            </div>
          `}
        </span>
        ${headerCollapsed && html`
          <span class="header-status-brand-compact">
            <span class="header-bear">ʕ·ᴥ·ʔ</span>
            <span class="header-wordmark">BAREMAIL</span>
          </span>
        `}
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
          ${' · '}
          <span class="settings-control" ref=${settingsPopoverRef}>
            <button class="settings-toggle" onClick=${() => setShowSettings(v => !v)} title="settings">settings</button>
            ${showSettings && html`
              <div class="settings-popover">
                <button class="settings-popover-toggle" onClick=${onToggleConversationMode}>
                  <span class="checkbox-glyph">${conversationMode ? '[x]' : '[ ]'}</span> conversation view
                </button>
                <button class="settings-popover-toggle" onClick=${onToggleShowSidebar}>
                  <span class="checkbox-glyph">${showSidebar ? '[x]' : '[ ]'}</span> show label sidebar
                </button>
                <button class="settings-popover-toggle" onClick=${onToggleShowCategoryTabs}>
                  <span class="checkbox-glyph">${showCategoryTabs ? '[x]' : '[ ]'}</span> show category tabs
                </button>
                <button class="settings-popover-toggle" onClick=${onToggleUseGmailLabelColors}>
                  <span class="checkbox-glyph">${useGmailLabelColors ? '[x]' : '[ ]'}</span> use gmail label colors
                </button>
                <button class="settings-popover-toggle" onClick=${onToggleFooterEnabled}>
                  <span class="checkbox-glyph">${footerEnabled ? '[x]' : '[ ]'}</span> append footer to sent messages
                </button>
                ${footerEnabled && html`
                  <textarea
                    class="settings-popover-footer-edit"
                    value=${footerText}
                    onInput=${(e: Event) => onSetFooterText((e.target as HTMLTextAreaElement).value)}
                    placeholder="footer text..."
                    rows=${4}
                  />
                `}
                <div class="settings-popover-section">
                  <div class="settings-popover-section-label">inbox row labels</div>
                  <div class="settings-popover-radios">
                    ${(['hidden', 'hover', 'always'] as const).map(mode => html`
                      <button
                        key=${mode}
                        class="settings-popover-radio ${inboxLabelMode === mode ? 'active' : ''}"
                        onClick=${() => onSetInboxLabelMode(mode)}
                      >
                        <span class="radio-glyph">${inboxLabelMode === mode ? '(•)' : '( )'}</span>
                        ${mode === 'hover' ? 'on hover' : mode}
                      </button>
                    `)}
                  </div>
                </div>
                <div class="settings-popover-section">
                  <div class="settings-popover-section-label">load more messages</div>
                  <div class="settings-popover-radios">
                    ${(['manual', 'auto'] as const).map(mode => html`
                      <button
                        key=${mode}
                        class="settings-popover-radio ${inboxScrollMode === mode ? 'active' : ''}"
                        onClick=${() => onSetInboxScrollMode(mode)}
                      >
                        <span class="radio-glyph">${inboxScrollMode === mode ? '(•)' : '( )'}</span>
                        ${mode === 'manual' ? 'on button click' : 'when scrolled to end'}
                      </button>
                    `)}
                  </div>
                </div>
              </div>
            `}
          </span>
          ${' · '}↓ ${formatBytes(totalBytes)} api
          <button
            class="header-collapse-btn"
            onClick=${onToggleHeaderCollapsed}
            title=${headerCollapsed ? 'expand header' : 'collapse header'}
          >${headerCollapsed ? '▾' : '▴'}</button>
        </span>
      </div>
    </header>
  `;
}
