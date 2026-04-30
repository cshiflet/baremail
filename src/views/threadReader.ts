import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import {
  Loading, formatFullDate, formatBytes, LabelChips, linkifyBody, sanitizeEmailHtml,
} from '../components/common.js';
import type { LinkMode } from '../components/common.js';
import {
  getThread,
  modifyThread,
  archiveThread,
  trashThread,
  starMessage,
  unstarMessage,
  markAsRead,
  markAsUnread,
  modifyMessage,
  getAttachment,
} from '../gmail.js';
import type { GmailMessage, GmailLabel, GmailThread, ComposeData } from '../types.js';

const html = htm.bind(h);

interface ThreadReaderProps {
  thread: GmailThread;
  onBack: () => void;
  onReply: (data: ComposeData) => void;
  onForward: (data: ComposeData) => void;
  onThreadUpdated: (thread: GmailThread) => void;
  onThreadArchived: (id: string) => void;
  labels: GmailLabel[];
  useGmailLabelColors: boolean;
}

export function ThreadReaderView({ thread: incomingThread, onBack, onReply, onForward, onThreadUpdated, onThreadArchived, labels, useGmailLabelColors }: ThreadReaderProps) {
  const [fullThread, setFullThread] = useState<GmailThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkMode, setLinkMode] = useState<LinkMode>('labeled');
  const [showLabelsForId, setShowLabelsForId] = useState<string | null>(null);
  const labelsPopoverRefs = useRef<Map<string, HTMLSpanElement | null>>(new Map());

  // Load the full thread (with bodies). The incoming thread has metadata only.
  useEffect(() => {
    let cancelled = false;
    setFullThread(null);
    setLoading(true);
    setShowLabelsForId(null);

    (async () => {
      try {
        const full = await getThread(incomingThread.id);
        if (cancelled) return;
        setFullThread(full);
        setLoading(false);

        // Auto-mark the whole thread as read on open, matching Gmail web.
        if (full.messages.some(m => m.isUnread)) {
          try {
            await modifyThread(full.id, undefined, ['UNREAD']);
            const updated: GmailThread = {
              ...full,
              messages: full.messages.map(m => ({
                ...m,
                isUnread: false,
                labelIds: m.labelIds.filter(l => l !== 'UNREAD'),
              })),
            };
            if (!cancelled) {
              setFullThread(updated);
              onThreadUpdated(updated);
            }
          } catch (err) {
            console.error('Failed to mark thread as read:', err);
          }
        } else {
          onThreadUpdated(full);
        }
      } catch (err) {
        console.error('Failed to load thread:', err);
        if (!cancelled) {
          setFullThread(incomingThread);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [incomingThread.id]);

  // 'h' toggles link display mode; 'l' opens the labels popover for the latest message.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key === 'h') {
        e.preventDefault();
        setLinkMode(m => m === 'labeled' ? 'url' : 'labeled');
      } else if (e.key === 'l') {
        e.preventDefault();
        const latest = fullThread?.messages[fullThread.messages.length - 1];
        if (latest) setShowLabelsForId(prev => prev === latest.id ? null : latest.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullThread]);

  // Click-outside to close the labels popover.
  useEffect(() => {
    if (!showLabelsForId) return;
    const close = (e: MouseEvent) => {
      const ref = labelsPopoverRefs.current.get(showLabelsForId);
      if (ref && !ref.contains(e.target as Node)) {
        setShowLabelsForId(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showLabelsForId]);

  const updateMessageInThread = (messageId: string, patch: (m: GmailMessage) => GmailMessage) => {
    if (!fullThread) return;
    const updated: GmailThread = {
      ...fullThread,
      messages: fullThread.messages.map(m => m.id === messageId ? patch(m) : m),
    };
    setFullThread(updated);
    onThreadUpdated(updated);
  };

  const handleArchive = async () => {
    if (!fullThread) return;
    try {
      await archiveThread(fullThread.id);
      onThreadArchived(fullThread.id);
    } catch (err) {
      console.error('Archive failed:', err);
    }
  };

  const handleDelete = async () => {
    if (!fullThread) return;
    try {
      await trashThread(fullThread.id);
      onThreadArchived(fullThread.id);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleReply = () => {
    if (!fullThread) return;
    const latest = fullThread.messages[fullThread.messages.length - 1];
    if (!latest) return;
    onReply({
      to: latest.from,
      cc: '',
      bcc: '',
      subject: latest.subject.startsWith('Re:') ? latest.subject : `Re: ${latest.subject}`,
      body: `\n\n────────────────────────────\nOn ${formatFullDate(latest.internalDate)}, ${latest.fromName} wrote:\n\n${latest.body}`,
      threadId: latest.threadId,
      inReplyTo: latest.id,
      isReply: true,
    });
  };

  const handleForward = () => {
    if (!fullThread) return;
    const latest = fullThread.messages[fullThread.messages.length - 1];
    if (!latest) return;
    onForward({
      to: '',
      cc: '',
      bcc: '',
      subject: latest.subject.startsWith('Fwd:') ? latest.subject : `Fwd: ${latest.subject}`,
      body: `\n\n────────────────────────────\nForwarded message from ${latest.fromName} <${latest.from}>\nDate: ${formatFullDate(latest.internalDate)}\nSubject: ${latest.subject}\n\n${latest.body}`,
      isForward: true,
    });
  };

  const handleStarMessage = async (message: GmailMessage) => {
    try {
      if (message.isStarred) await unstarMessage(message.id);
      else await starMessage(message.id);
      updateMessageInThread(message.id, m => ({ ...m, isStarred: !message.isStarred }));
    } catch (err) {
      console.error('Star toggle failed:', err);
    }
  };

  const handleToggleUnreadMessage = async (message: GmailMessage) => {
    try {
      const wantUnread = !message.isUnread;
      if (wantUnread) await markAsUnread(message.id);
      else await markAsRead(message.id);
      updateMessageInThread(message.id, m => ({
        ...m,
        isUnread: wantUnread,
        labelIds: wantUnread
          ? (m.labelIds.includes('UNREAD') ? m.labelIds : [...m.labelIds, 'UNREAD'])
          : m.labelIds.filter(l => l !== 'UNREAD'),
      }));
    } catch (err) {
      console.error('Toggle unread failed:', err);
    }
  };

  const handleToggleLabel = async (message: GmailMessage, label: GmailLabel) => {
    const currentIds = message.labelIds || [];
    const isApplied = currentIds.includes(label.id);
    const newLabelIds = isApplied
      ? currentIds.filter(id => id !== label.id)
      : [...currentIds, label.id];
    updateMessageInThread(message.id, m => ({ ...m, labelIds: newLabelIds }));
    try {
      if (isApplied) await modifyMessage(message.id, undefined, [label.id]);
      else await modifyMessage(message.id, [label.id], undefined);
    } catch (err) {
      console.error('Toggle label failed:', err);
    }
  };

  const handleDownloadAttachment = async (messageId: string, attachmentId: string, filename: string) => {
    try {
      const blob = await getAttachment(messageId, attachmentId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  if (loading) {
    return html`<${Loading} message="loading thread..." />`;
  }

  if (!fullThread || fullThread.messages.length === 0) {
    return html`
      <div class="no-results fade-in">
        <pre style="color: var(--red);">${`  ʕ;ᴥ;ʔ !`}</pre>
        <div style="color: var(--red); font-size: 12px;">empty thread</div>
        <button class="btn btn-secondary" style="margin-top: 16px;" onClick=${onBack}>← back</button>
      </div>
    `;
  }

  const messages = fullThread.messages;
  const latest = messages[messages.length - 1];
  const subject = latest?.subject || '(no subject)';
  const userLabels = labels.filter(l => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name));

  return html`
    <div class="fade-in">
      <div class="reader-toolbar">
        <button class="btn btn-ghost" onClick=${onBack}>← back</button>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary btn-sm" onClick=${handleArchive}>archive</button>
          <button class="btn btn-secondary btn-sm" onClick=${handleDelete}>delete</button>
        </div>
      </div>

      <div class="reader-header">
        <h2 class="reader-subject">${subject}</h2>
        <div class="reader-meta">
          <span class="reader-meta-label">messages</span>
          <span class="reader-meta-value">${messages.length}</span>
        </div>
      </div>

      <div class="reader-divider">${'─'.repeat(80)}</div>

      <div class="thread-messages">
        ${messages.map((message, idx) => {
          const sanitized = message.bodyHtml ? sanitizeEmailHtml(message.bodyHtml) : '';
          const isLast = idx === messages.length - 1;
          return html`
            <article class="thread-message ${isLast ? 'thread-message-last' : ''}" key=${message.id}>
              <header class="thread-message-header">
                <div class="thread-message-from">
                  <span class="thread-message-from-name">${message.fromName || message.from}</span>
                  ${message.fromName && html`<span class="thread-message-from-email">&lt;${message.from}&gt;</span>`}
                </div>
                <div class="thread-message-date">${formatFullDate(message.internalDate)}</div>
              </header>
              ${(message.to || message.cc) && html`
                <div class="thread-message-meta">
                  ${message.to && html`<span class="thread-message-meta-label">to</span><span class="thread-message-meta-value">${message.to}</span>`}
                  ${message.cc && html`<span class="thread-message-meta-label">cc</span><span class="thread-message-meta-value">${message.cc}</span>`}
                </div>
              `}
              <div class="thread-message-actions">
                <button class="btn btn-ghost btn-sm" onClick=${() => handleStarMessage(message)}>
                  ${message.isStarred ? '★ unstar' : '☆ star'}
                </button>
                <button class="btn btn-ghost btn-sm" onClick=${() => handleToggleUnreadMessage(message)}>
                  ${message.isUnread ? 'mark read' : 'mark unread'}
                </button>
                <span
                  class="labels-control"
                  ref=${(el: HTMLSpanElement | null) => { labelsPopoverRefs.current.set(message.id, el); }}
                >
                  <button class="btn btn-ghost btn-sm" onClick=${() => setShowLabelsForId(prev => prev === message.id ? null : message.id)}>labels</button>
                  ${showLabelsForId === message.id && html`
                    <div class="labels-popover">
                      ${userLabels.length === 0
                        ? html`<div class="labels-popover-empty">no user labels</div>`
                        : userLabels.map(label => {
                          const isApplied = message.labelIds?.includes(label.id) || false;
                          return html`
                            <button
                              key=${label.id}
                              class="labels-popover-option ${isApplied ? 'active' : ''}"
                              onClick=${() => handleToggleLabel(message, label)}
                            >
                              <span class="checkbox-glyph">${isApplied ? '[x]' : '[ ]'}</span>
                              <span class="labels-popover-name">${label.name}</span>
                            </button>
                          `;
                        })
                      }
                    </div>
                  `}
                </span>
              </div>
              ${message.labelIds && labels.some(l => l.type === 'user' && message.labelIds.includes(l.id)) && html`
                <div class="thread-message-labels">
                  <${LabelChips} messageLabelIds=${message.labelIds} allLabels=${labels} useColor=${useGmailLabelColors} />
                </div>
              `}
              ${sanitized
                ? html`<div class="reader-body" dangerouslySetInnerHTML=${{ __html: sanitized }} />`
                : html`<div class="reader-body">${message.body ? linkifyBody(message.body, linkMode) : '(empty message)'}</div>`
              }
              ${message.attachments?.length > 0 && html`
                <div class="thread-message-attachments">
                  <div style="color: var(--dim-text); font-size: 11px; margin-bottom: 8px;">
                    attachments (${message.attachments.length})
                  </div>
                  ${message.attachments.map(att => html`
                    <div key=${att.attachmentId} style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">
                      <span style="color: var(--mid-text); font-size: 12px;">${att.filename}</span>
                      <span style="color: var(--dim-text); font-size: 10px;">(${formatBytes(att.size)})</span>
                      <button
                        class="btn btn-dashed"
                        onClick=${() => handleDownloadAttachment(message.id, att.attachmentId, att.filename)}
                      >
                        download
                      </button>
                    </div>
                  `)}
                </div>
              `}
            </article>
          `;
        })}
      </div>

      <div class="reader-reply-bar">
        <button class="btn btn-action" onClick=${handleReply}>↩ reply</button>
        <button class="btn btn-secondary" onClick=${handleForward}>↪ forward</button>
      </div>
    </div>
  `;
}
