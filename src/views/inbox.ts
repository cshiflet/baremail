import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { formatDate, Loading, LabelChips } from '../components/common.js';
import {
  listMessages, batchGetMetadata, archiveMessage, markAsRead, markAsUnread,
  listThreads, batchGetThreadMetadata, archiveThread, modifyThread,
} from '../gmail.js';
import { cacheMessages, getAllCachedMessages } from '../cache.js';
import type { GmailMessage, GmailLabel, GmailThread } from '../types.js';

const html = htm.bind(h);

const API_SEARCH_MAX_RESULTS = 10;

function highlightMatch(text: string, query: string): any {
  if (!query || !text) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return html`${before}<mark class="search-highlight">${match}</mark>${after}`;
}

function localFilter(emails: GmailMessage[], query: string): GmailMessage[] {
  const q = query.toLowerCase();
  return emails.filter(e =>
    e.fromName.toLowerCase().includes(q) ||
    e.from.toLowerCase().includes(q) ||
    e.subject.toLowerCase().includes(q) ||
    (e.body && e.body.toLowerCase().includes(q)) ||
    (e.snippet && e.snippet.toLowerCase().includes(q))
  );
}

function localFilterThreads(threads: GmailThread[], query: string): GmailThread[] {
  const q = query.toLowerCase();
  return threads.filter(t =>
    t.messages.some(e =>
      e.fromName.toLowerCase().includes(q) ||
      e.from.toLowerCase().includes(q) ||
      e.subject.toLowerCase().includes(q) ||
      (e.body && e.body.toLowerCase().includes(q)) ||
      (e.snippet && e.snippet.toLowerCase().includes(q))
    )
  );
}

interface ThreadDisplay {
  senders: string;     // compact comma-joined unique senders
  subject: string;     // subject of the latest message
  date: number;        // internalDate of latest
  isUnread: boolean;
  isStarred: boolean;
  count: number;       // total messages in thread
  labelIds: string[];  // union of all message labelIds (deduped)
  latestSnippet: string;
}

function describeThread(thread: GmailThread, currentUserEmail: string | null): ThreadDisplay {
  const messages = thread.messages;
  const latest = messages[messages.length - 1];
  const isUnread = messages.some(m => m.isUnread);
  const isStarred = messages.some(m => m.isStarred);
  const allLabelIds = new Set<string>();
  for (const m of messages) for (const id of m.labelIds || []) allLabelIds.add(id);

  const seenSenders = new Set<string>();
  const senders: string[] = [];
  for (const m of messages) {
    const isMe = currentUserEmail && m.from === currentUserEmail;
    const display = isMe ? 'me' : (m.fromName || m.from);
    if (display && !seenSenders.has(display)) {
      seenSenders.add(display);
      senders.push(display);
    }
  }
  let sendersDisplay: string;
  if (senders.length <= 3) {
    sendersDisplay = senders.join(', ');
  } else {
    sendersDisplay = `${senders[0]}, …, ${senders[senders.length - 1]} (+${senders.length - 2})`;
  }

  return {
    senders: sendersDisplay,
    subject: latest?.subject || '(no subject)',
    date: latest?.internalDate || 0,
    isUnread,
    isStarred,
    count: messages.length,
    labelIds: Array.from(allLabelIds),
    latestSnippet: latest?.snippet || '',
  };
}

interface InboxProps {
  emails: GmailMessage[];
  threads: GmailThread[];
  cacheKey: string;
  activeLabel: string;
  localSearchQuery: string;
  apiSearchQuery: string;
  nextPageToken: string | null;
  needsFetch: boolean;
  loading: boolean;
  refreshTrigger: number;
  onEmailsLoaded: (cacheKey: string, emails: GmailMessage[], nextPageToken: string | null, append?: boolean) => void;
  onEmailUpdated: (email: GmailMessage) => void;
  onThreadsLoaded: (cacheKey: string, threads: GmailThread[], nextPageToken: string | null, append?: boolean) => void;
  onThreadUpdated: (thread: GmailThread) => void;
  onThreadArchived: (id: string) => void;
  onOpenEmail: (email: GmailMessage) => void;
  onOpenThread: (thread: GmailThread) => void;
  onSetLoading: (loading: boolean) => void;
  onSearchSubmit: () => void;
  onSearchClear: () => void;
  selectedIndex: number;
  inboxZeroBear: any;
  labels: GmailLabel[];
  useGmailLabelColors: boolean;
  inboxLabelMode: 'hidden' | 'hover' | 'always';
  conversationMode: boolean;
  userEmail: string | null;
  inboxScrollMode: 'manual' | 'auto';
}

export function InboxView({
  emails,
  threads,
  cacheKey,
  activeLabel,
  localSearchQuery,
  apiSearchQuery,
  nextPageToken,
  needsFetch,
  loading,
  refreshTrigger,
  onEmailsLoaded,
  onEmailUpdated,
  onThreadsLoaded,
  onThreadUpdated,
  onThreadArchived,
  onOpenEmail,
  onOpenThread,
  onSetLoading,
  onSearchSubmit,
  onSearchClear,
  selectedIndex,
  inboxZeroBear,
  labels,
  useGmailLabelColors,
  inboxLabelMode,
  conversationMode,
  userEmail,
  inboxScrollMode,
}: InboxProps) {
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const isLocalSearch = !!localSearchQuery && !apiSearchQuery;
  const isApiSearch = !!apiSearchQuery;

  const displayEmails = useMemo(() => {
    if (isLocalSearch) return localFilter(emails, localSearchQuery);
    return emails;
  }, [emails, localSearchQuery, isLocalSearch]);

  const displayThreads = useMemo(() => {
    if (isLocalSearch) return localFilterThreads(threads, localSearchQuery);
    return threads;
  }, [threads, localSearchQuery, isLocalSearch]);

  const itemCount = conversationMode ? displayThreads.length : displayEmails.length;

  const searchHighlight = isLocalSearch ? localSearchQuery : '';

  const fetchInbox = async (pageToken?: string) => {
    onSetLoading(true);
    setError(null);
    const key = cacheKey;
    try {
      const labelMap: Record<string, string[]> = {
        inbox: ['INBOX'],
        starred: ['STARRED'],
        sent: ['SENT'],
        drafts: ['DRAFT'],
      };

      let labelIds: string[];
      if (labelMap[activeLabel]) {
        labelIds = labelMap[activeLabel];
      } else if (activeLabel.startsWith('CATEGORY_')) {
        labelIds = [activeLabel, 'INBOX'];
      } else {
        labelIds = [activeLabel];
      }
      const maxResults = isApiSearch ? API_SEARCH_MAX_RESULTS : 25;
      const isLoadMore = !!pageToken;

      if (conversationMode) {
        const result = await listThreads(
          apiSearchQuery || undefined,
          pageToken,
          labelIds,
          maxResults
        );
        if (result.threads.length === 0) {
          onThreadsLoaded(key, [], null, isLoadMore);
          onSetLoading(false);
          setInitialLoad(false);
          return;
        }
        const ids = result.threads.map(t => t.id);
        const progressCb = isLoadMore ? undefined : (_loaded: number, _total: number, partial: GmailThread[]) => {
          onThreadsLoaded(key, partial, result.nextPageToken, false);
        };
        const fetched = await batchGetThreadMetadata(ids, progressCb);
        onThreadsLoaded(key, fetched, result.nextPageToken, isLoadMore);
      } else {
        const result = await listMessages(
          apiSearchQuery || undefined,
          pageToken,
          labelIds,
          maxResults
        );
        if (result.messages.length === 0) {
          onEmailsLoaded(key, [], null, isLoadMore);
          onSetLoading(false);
          setInitialLoad(false);
          return;
        }
        const ids = result.messages.map(m => m.id);
        const progressCb = isLoadMore ? undefined : (_loaded: number, _total: number, partial: GmailMessage[]) => {
          onEmailsLoaded(key, partial, result.nextPageToken, false);
        };
        const metadata = await batchGetMetadata(ids, progressCb);
        await cacheMessages(metadata);
        onEmailsLoaded(key, metadata, result.nextPageToken, isLoadMore);
      }
    } catch (err) {
      console.error('Failed to fetch inbox:', err);
      if (pageToken) {
        setError('Failed to load more — tap to retry');
      } else {
        setError(String(err));
        if (!conversationMode) {
          try {
            const cached = await getAllCachedMessages();
            if (cached.length > 0) {
              onEmailsLoaded(key, cached, null);
            }
          } catch {
            // No cached data either
          }
        }
      }
    } finally {
      onSetLoading(false);
      setInitialLoad(false);
    }
  };

  useEffect(() => {
    if (!needsFetch) {
      setInitialLoad(false);
      return;
    }
    setInitialLoad(true);
    fetchInbox();
  }, [cacheKey, needsFetch]);

  const lastRefreshRef = useRef(refreshTrigger);
  useEffect(() => {
    if (refreshTrigger === lastRefreshRef.current) return;
    lastRefreshRef.current = refreshTrigger;
    fetchInbox();
  }, [refreshTrigger]);

  // In auto-scroll mode, watch a sentinel near the bottom of the list and
  // trigger the next page when it scrolls into view (or within 200px of it).
  // The effect re-runs when nextPageToken or loading change so each pass uses
  // the current values; the observer disconnects on cleanup.
  useEffect(() => {
    if (inboxScrollMode !== 'auto') return;
    if (!nextPageToken) return;
    if (loading || error) return;
    if (isLocalSearch || isApiSearch) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        fetchInbox(nextPageToken);
      }
    }, { rootMargin: '200px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [inboxScrollMode, nextPageToken, loading, error, isLocalSearch, isApiSearch]);

  // Per-message handlers (used in messages mode)
  const handleArchiveEmail = async (e: Event, email: GmailMessage) => {
    e.stopPropagation();
    try {
      await archiveMessage(email.id);
      onEmailsLoaded(
        cacheKey,
        emails.filter(m => m.id !== email.id),
        nextPageToken
      );
    } catch (err) {
      console.error('Failed to archive:', err);
    }
  };

  const handleToggleUnreadEmail = async (e: Event, email: GmailMessage) => {
    e.stopPropagation();
    try {
      const wantUnread = !email.isUnread;
      if (wantUnread) await markAsUnread(email.id);
      else await markAsRead(email.id);
      onEmailUpdated({ ...email, isUnread: wantUnread });
    } catch (err) {
      console.error('Failed to toggle read:', err);
    }
  };

  // Thread-level handlers (used in conversation mode)
  const handleArchiveThread = async (e: Event, thread: GmailThread) => {
    e.stopPropagation();
    try {
      await archiveThread(thread.id);
      onThreadArchived(thread.id);
    } catch (err) {
      console.error('Failed to archive thread:', err);
    }
  };

  const handleToggleUnreadThread = async (e: Event, thread: GmailThread) => {
    e.stopPropagation();
    try {
      const wasUnread = thread.messages.some(m => m.isUnread);
      const wantUnread = !wasUnread;
      await modifyThread(
        thread.id,
        wantUnread ? ['UNREAD'] : undefined,
        wantUnread ? undefined : ['UNREAD'],
      );
      const updated: GmailThread = {
        ...thread,
        messages: thread.messages.map(m => ({
          ...m,
          isUnread: wantUnread,
          labelIds: wantUnread
            ? (m.labelIds.includes('UNREAD') ? m.labelIds : [...m.labelIds, 'UNREAD'])
            : m.labelIds.filter(l => l !== 'UNREAD'),
        })),
      };
      onThreadUpdated(updated);
    } catch (err) {
      console.error('Failed to toggle thread read:', err);
    }
  };

  const handleLoadMore = () => {
    const total = conversationMode ? threads.length : emails.length;
    if (total === 0) {
      if (conversationMode) onThreadsLoaded(cacheKey, [], null);
      else onEmailsLoaded(cacheKey, [], null);
      fetchInbox();
    } else if (nextPageToken) {
      fetchInbox(nextPageToken);
    }
  };

  if (loading && initialLoad) {
    return html`<${Loading} message=${isApiSearch ? 'searching gmail...' : 'fetching mail...'} />`;
  }

  if (error && itemCount === 0) {
    return html`
      <div class="no-results fade-in">
        <pre style="color: var(--red);">${`  ʕ;ᴥ;ʔ !`}</pre>
        <div style="color: var(--red); font-size: 12px; margin-bottom: 8px;">failed to load inbox</div>
        <div style="color: var(--dim-text); font-size: 11px; max-width: 500px; margin: 0 auto; word-break: break-word;">
          ${error}
        </div>
        <button class="btn btn-secondary" style="margin-top: 16px;" onClick=${() => fetchInbox()}>
          retry
        </button>
      </div>
    `;
  }

  // API search returned no results
  if (isApiSearch && itemCount === 0 && !loading) {
    return html`
      <div class="no-results fade-in">
        <pre>${`  ʕ;ᴥ;ʔ ?`}</pre>
        <div>no Gmail results for "${apiSearchQuery}"</div>
        <button class="btn btn-secondary" style="margin-top: 12px;" onClick=${onSearchClear}>
          ← back to ${activeLabel}
        </button>
      </div>
    `;
  }

  // Local search with no matches — prompt to search via API
  if (isLocalSearch && itemCount === 0 && !loading) {
    return html`
      <div class="no-results fade-in">
        <pre>${`  ʕ;ᴥ;ʔ`}</pre>
        <div>no local matches for "${localSearchQuery}"</div>
        <button
          class="btn btn-secondary"
          style="margin-top: 12px;"
          onClick=${onSearchSubmit}
        >
          search all gmail (~2KB) →
        </button>
        <div class="search-hint" style="margin-top: 8px;">
          or press enter in the search box
        </div>
      </div>
    `;
  }

  // No items at all (empty label)
  if (itemCount === 0 && !loading) {
    return html`
      <div>
        ${inboxZeroBear}
        ${nextPageToken && html`
          <div class="inbox-load-more" style="margin-top: 16px;">
            <button
              class="btn btn-secondary"
              onClick=${handleLoadMore}
              disabled=${loading}
            >
              ${loading ? 'loading...' : 'load more ↓ (~4KB)'}
            </button>
          </div>
        `}
      </div>
    `;
  }

  return html`
    <div>
      ${isApiSearch && html`
        <div class="search-results-header fade-in">
          <span>Gmail results for "${apiSearchQuery}" · ${itemCount} result${itemCount !== 1 ? 's' : ''}</span>
          <button class="btn btn-secondary btn-sm" onClick=${onSearchClear}>
            ✕ clear
          </button>
        </div>
      `}

      ${isLocalSearch && html`
        <div class="search-results-header fade-in">
          <span>${itemCount} of ${conversationMode ? threads.length : emails.length} loaded · press enter to search all gmail</span>
        </div>
      `}

      ${conversationMode
        ? displayThreads.map((thread, i) => {
            const display = describeThread(thread, userEmail);
            return html`
              <div
                key=${thread.id}
                class="inbox-row fade-in"
                onClick=${() => onOpenThread(thread)}
                style=${{
                  animationDelay: `${i * 40}ms`,
                  background: selectedIndex === i ? 'var(--bg-highlight)' : undefined,
                }}
              >
                <span class="inbox-indicator">
                  ${display.isUnread
                    ? html`<span class="unread">●</span>`
                    : display.isStarred
                      ? html`<span class="starred">★</span>`
                      : html`<span class="read">·</span>`
                  }
                </span>

                <div class="inbox-content">
                  <span class="inbox-from ${display.isUnread ? 'unread' : 'read'}">
                    ${searchHighlight
                      ? highlightMatch(display.senders, searchHighlight)
                      : display.senders}
                  </span>
                  <span class="inbox-subject ${display.isUnread ? 'unread' : 'read'}">
                    ${searchHighlight
                      ? highlightMatch(display.subject, searchHighlight)
                      : display.subject}
                    ${display.count > 1 && html`<span class="inbox-thread-count">(${display.count})</span>`}
                  </span>
                  ${inboxLabelMode !== 'hidden' && html`
                    <div class="inbox-row-labels ${inboxLabelMode === 'always' ? 'always' : ''}">
                      <${LabelChips} messageLabelIds=${display.labelIds} allLabels=${labels} useColor=${useGmailLabelColors} />
                    </div>
                  `}
                </div>

                <span class="inbox-date">
                  ${formatDate(display.date)}
                </span>

                <span class="inbox-actions">
                  <button
                    class="btn btn-secondary btn-sm"
                    onClick=${(e: Event) => handleToggleUnreadThread(e, thread)}
                  >
                    ${display.isUnread ? 'mark read' : 'mark unread'}
                  </button>
                  <button
                    class="btn btn-secondary btn-sm"
                    onClick=${(e: Event) => handleArchiveThread(e, thread)}
                  >
                    archive
                  </button>
                </span>
              </div>
            `;
          })
        : displayEmails.map((email, i) => html`
          <div
            key=${email.id}
            class="inbox-row fade-in"
            onClick=${() => onOpenEmail(email)}
            style=${{
              animationDelay: `${i * 40}ms`,
              background: selectedIndex === i ? 'var(--bg-highlight)' : undefined,
            }}
          >
            <span class="inbox-indicator">
              ${email.isUnread
                ? html`<span class="unread">●</span>`
                : email.isStarred
                  ? html`<span class="starred">★</span>`
                  : html`<span class="read">·</span>`
              }
            </span>

            <div class="inbox-content">
              <span class="inbox-from ${email.isUnread ? 'unread' : 'read'}">
                ${searchHighlight
                  ? highlightMatch(email.fromName || email.from, searchHighlight)
                  : (email.fromName || email.from)}
              </span>
              <span class="inbox-subject ${email.isUnread ? 'unread' : 'read'}">
                ${searchHighlight
                  ? highlightMatch(email.subject, searchHighlight)
                  : email.subject}
              </span>
              ${inboxLabelMode !== 'hidden' && html`
                <div class="inbox-row-labels ${inboxLabelMode === 'always' ? 'always' : ''}">
                  <${LabelChips} messageLabelIds=${email.labelIds} allLabels=${labels} useColor=${useGmailLabelColors} />
                </div>
              `}
            </div>

            <span class="inbox-date">
              ${formatDate(email.internalDate)}
            </span>

            <span class="inbox-actions">
              <button
                class="btn btn-secondary btn-sm"
                onClick=${(e: Event) => handleToggleUnreadEmail(e, email)}
              >
                ${email.isUnread ? 'mark read' : 'mark unread'}
              </button>
              <button
                class="btn btn-secondary btn-sm"
                onClick=${(e: Event) => handleArchiveEmail(e, email)}
              >
                archive
              </button>
            </span>
          </div>
        `)
      }

      ${!isLocalSearch && !isApiSearch && (nextPageToken || loading || error) && (
        inboxScrollMode === 'auto'
          ? html`
            ${nextPageToken && !loading && !error && html`
              <div ref=${sentinelRef} class="inbox-scroll-sentinel" />
            `}
            <div class="inbox-load-more">
              ${loading
                ? html`<span class="inbox-load-status">loading more...</span>`
                : error
                  ? html`
                    <button class="btn btn-secondary" onClick=${() => { setError(null); handleLoadMore(); }}>
                      retry ↻
                    </button>
                  `
                  : null
              }
            </div>
          `
          : html`
            <div class="inbox-load-more">
              <button
                class="btn btn-secondary"
                onClick=${() => { setError(null); handleLoadMore(); }}
                disabled=${loading}
              >
                ${loading ? 'loading...' : error ? 'retry ↻' : 'load more ↓ (~4KB)'}
              </button>
            </div>
          `
      )}

      ${!isLocalSearch && !isApiSearch && !nextPageToken && !loading && !error && itemCount > 0 && html`
        <div class="inbox-end fade-in">── end ──</div>
      `}

      ${isLocalSearch && html`
        <div class="inbox-load-more">
          <button
            class="btn btn-secondary"
            onClick=${onSearchSubmit}
          >
            search all gmail for "${localSearchQuery}" (~2KB) →
          </button>
        </div>
      `}

      ${isApiSearch && (nextPageToken || loading) && html`
        <div class="inbox-load-more">
          <button
            class="btn btn-secondary"
            onClick=${handleLoadMore}
            disabled=${loading}
          >
            ${loading ? 'loading...' : 'load more results ↓ (~2KB)'}
          </button>
        </div>
      `}
    </div>
  `;
}
