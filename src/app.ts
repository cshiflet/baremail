import { h, render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { initAuth, isAuthenticated, handleOAuthCallback, logout, getUserEmail } from './auth.js';
import { getTotalBytes, archiveMessage, starMessage, unstarMessage, markAsRead, markAsUnread, listLabels, archiveThread, modifyThread } from './gmail.js';
import { getPref, setPref, getOutboxCount } from './cache.js';
import { Header, WIDTH_PRESETS, DEFAULT_WIDTH_ID } from './components/header.js';
import { Nav } from './components/nav.js';
import { Footer } from './components/footer.js';
import { Sidebar } from './components/sidebar.js';
import { InboxZeroBear } from './components/bear.js';
import { LoginView } from './views/login.js';
import { InboxView } from './views/inbox.js';
import { ReaderView } from './views/reader.js';
import { ComposeView } from './views/compose.js';
import type { View, GmailMessage, ComposeData, ConnectionStatus, GmailLabel, GmailThread } from './types.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const html = htm.bind(h);

const EMPTY_COMPOSE: ComposeData = { to: '', cc: '', bcc: '', subject: '', body: '' };

const DEFAULT_FOOTER_TEXT = '\n\nʕ·ᴥ·ʔ sent with BAREMAIL — email for bad wifi — baremail.app';

function App() {
  const [view, setView] = useState<View>('login');
  const [selectedEmail, setSelectedEmail] = useState<GmailMessage | null>(null);
  const [composeData, setComposeData] = useState<ComposeData>(EMPTY_COMPOSE);
  const [activeLabel, setActiveLabel] = useState('inbox');
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [apiSearchQuery, setApiSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [containerWidth, setContainerWidthState] = useState<string>(DEFAULT_WIDTH_ID);
  const [mounted, setMounted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('online');
  const [outboxCount, setOutboxCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [showCategoryTabs, setShowCategoryTabs] = useState<boolean>(false);
  const [useGmailLabelColors, setUseGmailLabelColors] = useState<boolean>(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(false);
  const [footerEnabled, setFooterEnabled] = useState<boolean>(false);
  const [footerText, setFooterText] = useState<string>(DEFAULT_FOOTER_TEXT);
  const [showSidebar, setShowSidebar] = useState<boolean>(true);
  const [inboxLabelMode, setInboxLabelMode] = useState<'hidden' | 'hover' | 'always'>('hover');
  const [conversationMode, setConversationMode] = useState<boolean>(true);
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;

  interface LabelData {
    emails?: GmailMessage[];
    threads?: GmailThread[];
    nextPageToken: string | null;
  }
  const [labelCache, setLabelCache] = useState<Record<string, LabelData>>({});

  // Cache key includes mode so a mode toggle re-keys to a fresh entry and
  // triggers refetch instead of trying to mix shapes.
  const cacheKey = (apiSearchQuery ? `search:${apiSearchQuery}` : activeLabel) + (conversationMode ? ':t' : ':m');
  const currentData = labelCache[cacheKey];
  const emails = currentData?.emails || [];
  const threads = currentData?.threads || [];
  const nextPageToken = currentData?.nextPageToken || null;

  // ── Init ──
  useEffect(() => {
    (async () => {
      try {
        const savedTheme = await getPref<'dark' | 'light'>('theme', 'dark');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
        setTheme(initialTheme);
        document.documentElement.setAttribute('data-theme', initialTheme);

        const savedWidth = await getPref<string>('containerWidth', DEFAULT_WIDTH_ID);
        const initialWidth = WIDTH_PRESETS.find(p => p.id === savedWidth) ? savedWidth : DEFAULT_WIDTH_ID;
        setContainerWidthState(initialWidth);
        const initialPreset = WIDTH_PRESETS.find(p => p.id === initialWidth)!;
        document.documentElement.style.setProperty('--container-max-width', initialPreset.value);

        const callbackHandled = await handleOAuthCallback();
        if (callbackHandled || await initAuth()) {
          setView('inbox');
        }

        const count = await getOutboxCount();
        setOutboxCount(count);

        const cachedLabels = await getPref<GmailLabel[]>('labels', []);
        if (cachedLabels.length > 0) setLabels(cachedLabels);
        if (isAuthenticated()) {
          listLabels()
            .then(fresh => { setLabels(fresh); setPref('labels', fresh); })
            .catch(err => console.error('Failed to refresh labels:', err));
        }

        setShowCategoryTabs(await getPref<boolean>('showCategoryTabs', false));
        setUseGmailLabelColors(await getPref<boolean>('useGmailLabelColors', false));
        setHeaderCollapsed(await getPref<boolean>('headerCollapsed', false));
        setFooterEnabled(await getPref<boolean>('footerEnabled', false));
        setFooterText(await getPref<string>('footerText', DEFAULT_FOOTER_TEXT));
        setShowSidebar(await getPref<boolean>('showSidebar', true));
        const savedMode = await getPref<string>('inboxLabelMode', 'hover');
        setInboxLabelMode(savedMode === 'hidden' || savedMode === 'always' ? savedMode : 'hover');
        setConversationMode(await getPref<boolean>('conversationMode', true));
      } catch (err) {
        console.error('Init error:', err);
      }

      setTimeout(() => setMounted(true), 100);
    })();
  }, []);

  // ── Connection status ──
  useEffect(() => {
    const updateStatus = () => {
      if (!navigator.onLine) {
        setConnectionStatus('offline');
      } else {
        const conn = (navigator as any).connection;
        if (conn && conn.downlink < 0.5) {
          setConnectionStatus('slow');
        } else {
          setConnectionStatus('online');
        }
      }
    };

    updateStatus();
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
    };
  }, []);

  // ── Theme toggle ──
  const toggleTheme = useCallback(async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    await setPref('theme', next);
  }, [theme]);

  // ── Label settings ──
  const toggleShowCategoryTabs = useCallback(async () => {
    const next = !showCategoryTabs;
    setShowCategoryTabs(next);
    await setPref('showCategoryTabs', next);
  }, [showCategoryTabs]);

  const toggleUseGmailLabelColors = useCallback(async () => {
    const next = !useGmailLabelColors;
    setUseGmailLabelColors(next);
    await setPref('useGmailLabelColors', next);
  }, [useGmailLabelColors]);

  const toggleHeaderCollapsed = useCallback(async () => {
    const next = !headerCollapsed;
    setHeaderCollapsed(next);
    await setPref('headerCollapsed', next);
  }, [headerCollapsed]);

  const toggleFooterEnabled = useCallback(async () => {
    const next = !footerEnabled;
    setFooterEnabled(next);
    await setPref('footerEnabled', next);
  }, [footerEnabled]);

  const updateFooterText = useCallback(async (text: string) => {
    setFooterText(text);
    await setPref('footerText', text);
  }, []);

  const toggleShowSidebar = useCallback(async () => {
    const next = !showSidebar;
    setShowSidebar(next);
    await setPref('showSidebar', next);
  }, [showSidebar]);

  const updateInboxLabelMode = useCallback(async (mode: 'hidden' | 'hover' | 'always') => {
    setInboxLabelMode(mode);
    await setPref('inboxLabelMode', mode);
  }, []);

  const toggleConversationMode = useCallback(async () => {
    const next = !conversationMode;
    setConversationMode(next);
    await setPref('conversationMode', next);
  }, [conversationMode]);

  // ── Container width ──
  const setContainerWidth = useCallback(async (id: string) => {
    const preset = WIDTH_PRESETS.find(p => p.id === id);
    if (!preset) return;
    setContainerWidthState(id);
    document.documentElement.style.setProperty('--container-max-width', preset.value);
    await setPref('containerWidth', id);
  }, []);

  const cycleContainerWidth = useCallback(async () => {
    const idx = WIDTH_PRESETS.findIndex(p => p.id === containerWidth);
    const next = WIDTH_PRESETS[(idx + 1) % WIDTH_PRESETS.length];
    setContainerWidthState(next.id);
    document.documentElement.style.setProperty('--container-max-width', next.value);
    await setPref('containerWidth', next.id);
  }, [containerWidth]);

  // ── Navigation helpers ──
  const openEmail = useCallback((email: GmailMessage) => {
    setSelectedEmail(email);
    setView('reader');
  }, []);

  const startCompose = useCallback(() => {
    setComposeData(EMPTY_COMPOSE);
    setView('compose');
  }, []);

  const handleReply = useCallback((data: ComposeData) => {
    setComposeData(data);
    setView('compose');
  }, []);

  const handleForward = useCallback((data: ComposeData) => {
    setComposeData(data);
    setView('compose');
  }, []);

  const goToInbox = useCallback(() => {
    setView('inbox');
    setSelectedEmail(null);
  }, []);

  const handleTabClick = useCallback((tab: string) => {
    setActiveLabel(tab);
    setView('inbox');
    setSelectedEmail(null);
    setLocalSearchQuery('');
    setApiSearchQuery('');
    setSelectedIndex(0);
  }, []);

  const handleSearchInput = useCallback((q: string) => {
    setLocalSearchQuery(q);
    if (apiSearchQuery) setApiSearchQuery('');
    setSelectedIndex(0);
  }, [apiSearchQuery]);

  const handleSearchSubmit = useCallback(() => {
    if (!localSearchQuery.trim()) return;
    setApiSearchQuery(localSearchQuery.trim());
    setSelectedIndex(0);
  }, [localSearchQuery]);

  const handleSearchClear = useCallback(() => {
    setLocalSearchQuery('');
    setApiSearchQuery('');
    setSelectedIndex(0);
  }, []);

  const handleEmailsLoaded = useCallback((key: string, newEmails: GmailMessage[], token: string | null, append = false) => {
    setLabelCache(prev => {
      const existing = prev[key];
      let emails: GmailMessage[];
      if (append) {
        const existingIds = new Set((existing?.emails || []).map(e => e.id));
        const deduped = newEmails.filter(e => !existingIds.has(e.id));
        emails = [...(existing?.emails || []), ...deduped];
      } else {
        emails = newEmails;
      }
      return {
        ...prev,
        [key]: { ...existing, emails, nextPageToken: token },
      };
    });
  }, []);

  const handleThreadsLoaded = useCallback((key: string, newThreads: GmailThread[], token: string | null, append = false) => {
    setLabelCache(prev => {
      const existing = prev[key];
      let threads: GmailThread[];
      if (append) {
        const existingIds = new Set((existing?.threads || []).map(t => t.id));
        const deduped = newThreads.filter(t => !existingIds.has(t.id));
        threads = [...(existing?.threads || []), ...deduped];
      } else {
        threads = newThreads;
      }
      return {
        ...prev,
        [key]: { ...existing, threads, nextPageToken: token },
      };
    });
  }, []);

  const handleThreadUpdated = useCallback((updated: GmailThread) => {
    setLabelCache(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const data = next[key];
        if (data.threads?.some(t => t.id === updated.id)) {
          next[key] = { ...data, threads: data.threads.map(t => t.id === updated.id ? updated : t) };
        }
      }
      return next;
    });
  }, []);

  const handleThreadArchived = useCallback((id: string) => {
    setLabelCache(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const data = next[key];
        if (data.threads?.some(t => t.id === id)) {
          next[key] = { ...data, threads: data.threads.filter(t => t.id !== id) };
        }
      }
      return next;
    });
    if (view === 'reader') goToInbox();
  }, [view, goToInbox]);

  const handleEmailUpdated = useCallback((updated: GmailMessage) => {
    const lite: GmailMessage = { ...updated, body: '', bodyHtml: '', attachments: [] };
    setLabelCache(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const data = next[key];
        if (data.emails.some(e => e.id === lite.id)) {
          next[key] = { ...data, emails: data.emails.map(e => e.id === lite.id ? lite : e) };
        }
      }
      return next;
    });
    if (selectedEmail?.id === updated.id) setSelectedEmail(updated);
  }, [selectedEmail]);

  const handleArchived = useCallback((id: string) => {
    setLabelCache(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const data = next[key];
        if (data.emails.some(e => e.id === id)) {
          next[key] = { ...data, emails: data.emails.filter(e => e.id !== id) };
        }
      }
      return next;
    });
    if (view === 'reader') goToInbox();
  }, [view, goToInbox]);

  const handleSent = useCallback(async () => {
    goToInbox();
    const count = await getOutboxCount();
    setOutboxCount(count);
  }, [goToInbox]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger(n => n + 1);
    setActiveLabel('inbox');
    setApiSearchQuery('');
    setLocalSearchQuery('');
    setView('inbox');
    setSelectedEmail(null);
    setSelectedIndex(0);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setView('login');
    setLabelCache({});
    setSelectedEmail(null);
  }, []);


  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'inbox' && (localSearchQuery || apiSearchQuery)) {
          handleSearchClear();
          (document.activeElement as HTMLElement)?.blur();
        } else if (view === 'reader') goToInbox();
        else if (view === 'compose') goToInbox();
        return;
      }

      if (view === 'compose') {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          const sendBtn = document.querySelector('.compose-send-bar .btn-primary') as HTMLButtonElement;
          sendBtn?.click();
        }
        return;
      }

      if (isInput) return;
      const isButton = target.tagName === 'BUTTON';

      if (!isButton && e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        const tabs = ['inbox', 'starred', 'sent', 'drafts', 'compose'];
        const idx = parseInt(e.key) - 1;
        if (tabs[idx] === 'compose') startCompose();
        else handleTabClick(tabs[idx]);
        return;
      }

      if (view === 'inbox') {
        const inboxItemCount = conversationMode ? threads.length : emails.length;
        if (e.key === '/') {
          e.preventDefault();
          const searchInput = document.querySelector('.nav-search input') as HTMLInputElement;
          searchInput?.focus();
        } else if (e.key === 'j') {
          e.preventDefault();
          setSelectedIndex(i => Math.min(i + 1, inboxItemCount - 1));
        } else if (e.key === 'k') {
          e.preventDefault();
          setSelectedIndex(i => Math.max(i - 1, 0));
        } else if ((e.key === 'o' || e.key === 'Enter') && !isButton) {
          e.preventDefault();
          if (conversationMode) {
            const thread = threads[selectedIndexRef.current];
            const latest = thread?.messages[thread.messages.length - 1];
            if (latest) openEmail(latest);
          } else {
            const email = emails[selectedIndexRef.current];
            if (email) openEmail(email);
          }
        } else if (e.key === 'e') {
          e.preventDefault();
          if (conversationMode) {
            const thread = threads[selectedIndexRef.current];
            if (thread) archiveThread(thread.id).then(() => handleThreadArchived(thread.id));
          } else {
            const email = emails[selectedIndexRef.current];
            if (email) archiveMessage(email.id).then(() => handleArchived(email.id));
          }
        } else if (e.key === 's') {
          e.preventDefault();
          if (conversationMode) {
            const thread = threads[selectedIndexRef.current];
            const latest = thread?.messages[thread.messages.length - 1];
            if (thread && latest) {
              const toggle = latest.isStarred ? unstarMessage : starMessage;
              toggle(latest.id).then(() => {
                const updatedThread: GmailThread = {
                  ...thread,
                  messages: thread.messages.map(m =>
                    m.id === latest.id ? { ...m, isStarred: !latest.isStarred } : m
                  ),
                };
                handleThreadUpdated(updatedThread);
              });
            }
          } else {
            const email = emails[selectedIndexRef.current];
            if (email) {
              const toggle = email.isStarred ? unstarMessage : starMessage;
              toggle(email.id).then(() => {
                handleEmailUpdated({ ...email, isStarred: !email.isStarred });
              });
            }
          }
        } else if (e.key === 'u') {
          e.preventDefault();
          if (conversationMode) {
            const thread = threads[selectedIndexRef.current];
            if (thread) {
              const wasUnread = thread.messages.some(m => m.isUnread);
              const wantUnread = !wasUnread;
              modifyThread(thread.id, wantUnread ? ['UNREAD'] : undefined, wantUnread ? undefined : ['UNREAD']).then(() => {
                const updatedThread: GmailThread = {
                  ...thread,
                  messages: thread.messages.map(m => ({
                    ...m,
                    isUnread: wantUnread,
                    labelIds: wantUnread
                      ? (m.labelIds.includes('UNREAD') ? m.labelIds : [...m.labelIds, 'UNREAD'])
                      : m.labelIds.filter(l => l !== 'UNREAD'),
                  })),
                };
                handleThreadUpdated(updatedThread);
              });
            }
          } else {
            const email = emails[selectedIndexRef.current];
            if (email) {
              const wantUnread = !email.isUnread;
              const fn = wantUnread ? markAsUnread : markAsRead;
              fn(email.id).then(() => {
                handleEmailUpdated({ ...email, isUnread: wantUnread });
              });
            }
          }
        } else if (e.key === 'c') {
          e.preventDefault();
          startCompose();
        }
        return;
      }

      if (view === 'reader') {
        if (e.key === 'r') {
          e.preventDefault();
          const replyBtn = document.querySelector('.reader-reply-bar .btn-action') as HTMLButtonElement;
          replyBtn?.click();
        } else if (e.key === 'e') {
          e.preventDefault();
          if (selectedEmail) {
            archiveMessage(selectedEmail.id).then(() => handleArchived(selectedEmail.id));
          }
        } else if (e.key === 's') {
          e.preventDefault();
          if (selectedEmail) {
            const toggle = selectedEmail.isStarred ? unstarMessage : starMessage;
            toggle(selectedEmail.id).then(() => {
              handleEmailUpdated({ ...selectedEmail, isStarred: !selectedEmail.isStarred });
            });
          }
        } else if (e.key === 'u') {
          e.preventDefault();
          if (selectedEmail) {
            const wantUnread = !selectedEmail.isUnread;
            const fn = wantUnread ? markAsUnread : markAsRead;
            fn(selectedEmail.id).then(() => {
              handleEmailUpdated({ ...selectedEmail, isUnread: wantUnread });
            });
          }
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [view, emails, threads, conversationMode, selectedEmail, localSearchQuery, apiSearchQuery, openEmail, startCompose, goToInbox, handleArchived, handleEmailUpdated, handleThreadArchived, handleThreadUpdated, handleTabClick, handleSearchClear]);

  // ── Derived state ──
  const inboxKey = `inbox${conversationMode ? ':t' : ':m'}`;
  const inboxEntry = labelCache[inboxKey];
  const inboxEmails = inboxEntry?.emails || [];
  const inboxThreads = inboxEntry?.threads || [];
  const inboxUnreadCount = conversationMode
    ? inboxThreads.filter(t => t.messages.some(m => m.isUnread)).length
    : inboxEmails.filter(e => e.isUnread).length;
  const inboxTotalCount = conversationMode ? inboxThreads.length : inboxEmails.length;
  const currentUnreadCount = emails.filter(e => e.isUnread).length;
  const totalBytes = getTotalBytes();
  const isOnline = connectionStatus !== 'offline';

  // tabCounts is keyed on the base label name. Pull counts from whichever
  // entry matches the current mode so the displayed numbers reflect what
  // the user actually sees.
  const tabCounts: Record<string, number> = {};
  for (const key of Object.keys(labelCache)) {
    const isThreadsKey = key.endsWith(':t');
    const isMessagesKey = key.endsWith(':m');
    if (!isThreadsKey && !isMessagesKey) continue;
    if ((isThreadsKey && !conversationMode) || (isMessagesKey && conversationMode)) continue;
    const baseKey = key.slice(0, -2);
    const data = labelCache[key];
    tabCounts[baseKey] = (conversationMode ? data.threads?.length : data.emails?.length) || 0;
  }

  // ── Login view ──
  if (view === 'login' || !isAuthenticated()) {
    return html`
      <div>
        <div class="crt-scanlines" />
        <div class="crt-vignette" />
        <div class="app-container ${mounted ? 'mounted' : ''}">
          <${LoginView} />
        </div>
      </div>
    `;
  }

  // ── Authenticated views ──
  return html`
    <div>
      <div class="crt-scanlines" />
      <div class="crt-vignette" />

      ${connectionStatus === 'offline' && html`
        <div class="connection-banner offline">
          ⚡ offline${outboxCount > 0 ? ` · ${outboxCount} message${outboxCount > 1 ? 's' : ''} queued` : ''}
        </div>
      `}
      ${connectionStatus === 'slow' && html`
        <div class="connection-banner slow">
          ◑ slow connection detected
        </div>
      `}

      <div class="layout">
        ${showSidebar && labels.some(l => l.type === 'user') && html`
          <button
            class="sidebar-toggle"
            onClick=${() => setSidebarOpen(o => !o)}
            title="toggle labels"
          >☰</button>
          <${Sidebar}
            labels=${labels}
            activeLabel=${activeLabel}
            useGmailLabelColors=${useGmailLabelColors}
            onLabelClick=${handleTabClick}
            isOpen=${sidebarOpen}
            onClose=${() => setSidebarOpen(false)}
          />
          <div class="sidebar-divider" aria-hidden="true">${'|\n'.repeat(200).slice(0, -1)}</div>
        `}
      <div class="app-container ${mounted ? 'mounted' : ''}">
        <div class="sticky-top">
          <${Header}
            connectionStatus=${connectionStatus}
            unreadCount=${inboxUnreadCount}
            totalEmails=${inboxTotalCount}
            totalBytes=${totalBytes}
            theme=${theme}
            onToggleTheme=${toggleTheme}
            userEmail=${getUserEmail()}
            onLogout=${handleLogout}
            onRefresh=${handleRefresh}
            containerWidth=${containerWidth}
            onSetContainerWidth=${setContainerWidth}
            onCycleContainerWidth=${cycleContainerWidth}
            showCategoryTabs=${showCategoryTabs}
            onToggleShowCategoryTabs=${toggleShowCategoryTabs}
            useGmailLabelColors=${useGmailLabelColors}
            onToggleUseGmailLabelColors=${toggleUseGmailLabelColors}
            headerCollapsed=${headerCollapsed}
            onToggleHeaderCollapsed=${toggleHeaderCollapsed}
            footerEnabled=${footerEnabled}
            onToggleFooterEnabled=${toggleFooterEnabled}
            footerText=${footerText}
            onSetFooterText=${updateFooterText}
            showSidebar=${showSidebar}
            onToggleShowSidebar=${toggleShowSidebar}
            inboxLabelMode=${inboxLabelMode}
            onSetInboxLabelMode=${updateInboxLabelMode}
            conversationMode=${conversationMode}
            onToggleConversationMode=${toggleConversationMode}
          />

          <${Nav}
            activeLabel=${activeLabel}
            view=${view}
            tabCounts=${tabCounts}
            searchQuery=${localSearchQuery}
            apiSearchQuery=${apiSearchQuery}
            onTabClick=${handleTabClick}
            onSearchInput=${handleSearchInput}
            onSearchSubmit=${handleSearchSubmit}
            onSearchClear=${handleSearchClear}
            onCompose=${startCompose}
            labels=${labels}
            showCategoryTabs=${showCategoryTabs}
          />
        </div>

        ${view === 'inbox' && html`
          <${InboxView}
            emails=${emails}
            cacheKey=${cacheKey}
            activeLabel=${activeLabel}
            localSearchQuery=${localSearchQuery}
            apiSearchQuery=${apiSearchQuery}
            nextPageToken=${nextPageToken}
            needsFetch=${!currentData}
            loading=${loading}
            refreshTrigger=${refreshTrigger}
            onEmailsLoaded=${handleEmailsLoaded}
            onEmailUpdated=${handleEmailUpdated}
            onOpenEmail=${openEmail}
            onSetLoading=${setLoading}
            onSearchSubmit=${handleSearchSubmit}
            onSearchClear=${handleSearchClear}
            selectedIndex=${selectedIndex}
            inboxZeroBear=${html`<${InboxZeroBear} />`}
            labels=${labels}
            useGmailLabelColors=${useGmailLabelColors}
            inboxLabelMode=${inboxLabelMode}
            conversationMode=${conversationMode}
            threads=${threads}
            onThreadsLoaded=${handleThreadsLoaded}
            onThreadUpdated=${handleThreadUpdated}
            onThreadArchived=${handleThreadArchived}
            userEmail=${getUserEmail()}
          />
        `}

        ${view === 'reader' && selectedEmail && html`
          <${ReaderView}
            email=${selectedEmail}
            onBack=${goToInbox}
            onReply=${handleReply}
            onForward=${handleForward}
            onEmailUpdated=${handleEmailUpdated}
            onArchived=${handleArchived}
            labels=${labels}
            useGmailLabelColors=${useGmailLabelColors}
          />
        `}

        ${view === 'compose' && html`
          <${ComposeView}
            data=${composeData}
            onSent=${handleSent}
            onDiscard=${goToInbox}
            isOnline=${isOnline}
            footerEnabled=${footerEnabled}
            footerText=${footerText}
          />
        `}

        <${Footer} view=${view} hasActiveSearch=${!!(localSearchQuery || apiSearchQuery)} />
      </div>
      </div>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app')!);
