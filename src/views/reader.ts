import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { Loading, formatFullDate, formatBytes, LabelChips, linkifyBody, prepareEmailHtml, loadDeferredImages } from '../components/common.js';
import type { LinkMode } from '../components/common.js';
import {
  getMessage,
  archiveMessage,
  starMessage,
  unstarMessage,
  trashMessage,
  markAsRead,
  markAsUnread,
  modifyMessage,
  getAttachment,
} from '../gmail.js';
import { cacheMessage, getCachedMessage } from '../cache.js';
import type { GmailMessage, ComposeData, GmailLabel } from '../types.js';

const html = htm.bind(h);

interface ReaderProps {
  email: GmailMessage;
  onBack: () => void;
  onReply: (data: ComposeData) => void;
  onForward: (data: ComposeData) => void;
  onEmailUpdated: (email: GmailMessage) => void;
  onArchived: (id: string) => void;
  labels: GmailLabel[];
  useGmailLabelColors: boolean;
}

export function ReaderView({ email, onBack, onReply, onForward, onEmailUpdated, onArchived, labels, useGmailLabelColors }: ReaderProps) {
  const [fullEmail, setFullEmail] = useState<GmailMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHtml, setShowHtml] = useState(false);
  const [linkMode, setLinkMode] = useState<LinkMode>('labeled');
  const [showLabels, setShowLabels] = useState(false);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const labelsPopoverRef = useRef<HTMLSpanElement>(null);
  const htmlBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key === 'h') {
        e.preventDefault();
        setLinkMode(m => m === 'labeled' ? 'url' : 'labeled');
      } else if (e.key === 'l') {
        e.preventDefault();
        setShowLabels(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!showLabels) return;
    const close = (e: MouseEvent) => {
      if (labelsPopoverRef.current && !labelsPopoverRef.current.contains(e.target as Node)) {
        setShowLabels(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showLabels]);

  useEffect(() => {
    let cancelled = false;
    setFullEmail(null);
    setLoading(true);
    setShowHtml(false);

    (async () => {
      try {
        const cached = await getCachedMessage(email.id);
        const cacheUsable = cached?.body && cached.body.trim().length > 20;
        if (cacheUsable) {
          if (!cancelled) {
            setFullEmail(cached);
            setLoading(false);
          }
          return;
        }

        const full = await getMessage(email.id);
        await cacheMessage(full);

        if (!cancelled) {
          setFullEmail(full);
          setLoading(false);
        }

        if (full.isUnread) {
          await markAsRead(full.id);
          onEmailUpdated({ ...full, isUnread: false });
        } else {
          onEmailUpdated(full);
        }
      } catch (err) {
        console.error('Failed to load message:', err);
        if (!cancelled) {
          setFullEmail({ ...email, body: '(failed to load message body)' });
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [email.id]);

  const handleArchive = async () => {
    try {
      await archiveMessage(email.id);
      onArchived(email.id);
    } catch (err) {
      console.error('Archive failed:', err);
    }
  };

  const handleStar = async () => {
    try {
      if (email.isStarred) {
        await unstarMessage(email.id);
        onEmailUpdated({ ...email, isStarred: false });
      } else {
        await starMessage(email.id);
        onEmailUpdated({ ...email, isStarred: true });
      }
    } catch (err) {
      console.error('Star toggle failed:', err);
    }
  };

  const handleDelete = async () => {
    try {
      await trashMessage(email.id);
      onArchived(email.id);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleToggleUnread = async () => {
    try {
      const wantUnread = !email.isUnread;
      if (wantUnread) await markAsUnread(email.id);
      else await markAsRead(email.id);
      if (fullEmail) setFullEmail({ ...fullEmail, isUnread: wantUnread });
      onEmailUpdated({ ...email, isUnread: wantUnread });
    } catch (err) {
      console.error('Toggle read failed:', err);
    }
  };

  const handleToggleLabel = async (label: GmailLabel) => {
    const currentIds = email.labelIds || [];
    const isApplied = currentIds.includes(label.id);
    const newLabelIds = isApplied
      ? currentIds.filter(id => id !== label.id)
      : [...currentIds, label.id];
    if (fullEmail) setFullEmail({ ...fullEmail, labelIds: newLabelIds });
    onEmailUpdated({ ...email, labelIds: newLabelIds });
    try {
      if (isApplied) await modifyMessage(email.id, undefined, [label.id]);
      else await modifyMessage(email.id, [label.id], undefined);
    } catch (err) {
      console.error('Toggle label failed:', err);
    }
  };

  const handleReply = () => {
    if (!fullEmail) return;
    onReply({
      to: fullEmail.from,
      cc: '',
      bcc: '',
      subject: fullEmail.subject.startsWith('Re:') ? fullEmail.subject : `Re: ${fullEmail.subject}`,
      body: `\n\n────────────────────────────\nOn ${formatFullDate(fullEmail.internalDate)}, ${fullEmail.fromName} wrote:\n\n${fullEmail.body}`,
      threadId: fullEmail.threadId,
      inReplyTo: fullEmail.id,
      isReply: true,
    });
  };

  const handleForward = () => {
    if (!fullEmail) return;
    onForward({
      to: '',
      cc: '',
      bcc: '',
      subject: fullEmail.subject.startsWith('Fwd:') ? fullEmail.subject : `Fwd: ${fullEmail.subject}`,
      body: `\n\n────────────────────────────\nForwarded message from ${fullEmail.fromName} <${fullEmail.from}>\nDate: ${formatFullDate(fullEmail.internalDate)}\nSubject: ${fullEmail.subject}\n\n${fullEmail.body}`,
      isForward: true,
    });
  };

  const handleDownloadAttachment = async (attachmentId: string, filename: string) => {
    try {
      const blob = await getAttachment(email.id, attachmentId);
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

  const displayEmail = fullEmail || email;
  const body = displayEmail.body;

  const preparedHtml = useMemo(() => {
    if (!displayEmail.bodyHtml) return { html: '', deferredCount: 0 };
    return prepareEmailHtml(displayEmail.bodyHtml);
  }, [displayEmail.bodyHtml]);

  // Reset image-loaded state when the email or HTML body changes.
  useEffect(() => { setImagesLoaded(false); }, [displayEmail.id, preparedHtml.html]);

  // Re-apply deferred-image loads after the body re-renders. This handles the
  // case where the user loaded images, switched to plain text, then back to
  // HTML — the new DOM has data-baremail-src again, but we already have the
  // user's consent, so we restore src without re-prompting.
  useEffect(() => {
    if (showHtml && imagesLoaded) loadDeferredImages(htmlBodyRef.current);
  }, [showHtml, imagesLoaded, preparedHtml.html]);

  const handleLoadImages = () => {
    loadDeferredImages(htmlBodyRef.current);
    setImagesLoaded(true);
  };

  if (loading) {
    return html`<${Loading} message="loading message..." />`;
  }

  return html`
    <div class="fade-in">
      <div class="reader-toolbar">
        <button class="btn btn-ghost" onClick=${onBack}>← back</button>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary btn-sm" onClick=${handleArchive}>archive</button>
          <button class="btn btn-secondary btn-sm" onClick=${handleToggleUnread}>
            ${email.isUnread ? 'mark read' : 'mark unread'}
          </button>
          <span class="labels-control" ref=${labelsPopoverRef}>
            <button class="btn btn-secondary btn-sm" onClick=${() => setShowLabels(v => !v)}>labels</button>
            ${showLabels && html`
              <div class="labels-popover">
                ${labels.filter(l => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name)).length === 0
                  ? html`<div class="labels-popover-empty">no user labels</div>`
                  : labels.filter(l => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name)).map(label => {
                    const isApplied = email.labelIds?.includes(label.id) || false;
                    return html`
                      <button
                        key=${label.id}
                        class="labels-popover-option ${isApplied ? 'active' : ''}"
                        onClick=${() => handleToggleLabel(label)}
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
          <button class="btn btn-secondary btn-sm" onClick=${handleStar}>
            ${email.isStarred ? '★ unstar' : '☆ star'}
          </button>
          <button class="btn btn-secondary btn-sm" onClick=${handleDelete}>delete</button>
        </div>
      </div>

      <div class="reader-header">
        <h2 class="reader-subject">${displayEmail.subject}</h2>
        <div class="reader-meta">
          <span class="reader-meta-label">from</span>
          <span class="reader-meta-value">
            ${displayEmail.fromName + ' <' + displayEmail.from + '>'}
          </span>
          ${displayEmail.to && html`
            <span class="reader-meta-label">to</span>
            <span class="reader-meta-value">${displayEmail.to}</span>
          `}
          ${displayEmail.cc && html`
            <span class="reader-meta-label">cc</span>
            <span class="reader-meta-value">${displayEmail.cc}</span>
          `}
          <span class="reader-meta-label">date</span>
          <span class="reader-meta-value">${formatFullDate(displayEmail.internalDate)}</span>
          ${displayEmail.labelIds && labels.some(l => l.type === 'user' && displayEmail.labelIds.includes(l.id)) && html`
            <span class="reader-meta-label">labels</span>
            <span class="reader-meta-value">
              <${LabelChips} messageLabelIds=${displayEmail.labelIds} allLabels=${labels} useColor=${useGmailLabelColors} />
            </span>
          `}
        </div>
      </div>

      <div class="reader-divider">${'─'.repeat(80)}</div>

      ${showHtml && displayEmail.bodyHtml ? html`
        ${preparedHtml.deferredCount > 0 && !imagesLoaded && html`
          <button class="btn btn-ghost" style="font-size: 11px; margin: 8px 0;" onClick=${handleLoadImages}>
            display ${preparedHtml.deferredCount} external image${preparedHtml.deferredCount === 1 ? '' : 's'}
          </button>
        `}
        <div
          class="reader-body"
          ref=${htmlBodyRef}
          dangerouslySetInnerHTML=${{ __html: preparedHtml.html }}
        />
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          ${preparedHtml.deferredCount > 0 && !imagesLoaded && html`
            <button class="btn btn-ghost" style="font-size: 11px;" onClick=${handleLoadImages}>
              display ${preparedHtml.deferredCount} external image${preparedHtml.deferredCount === 1 ? '' : 's'}
            </button>
          `}
          <button class="btn btn-ghost" style="font-size: 11px;" onClick=${() => setShowHtml(false)}>
            ← plain text
          </button>
        </div>
      ` : html`
        <div class="reader-body">
          ${body ? linkifyBody(body, linkMode) : '(empty message)'}
        </div>
        ${displayEmail.bodyHtml && html`
          <button class="btn btn-ghost" style="margin-top: 8px; font-size: 11px;" onClick=${() => setShowHtml(true)}>
            show original HTML
          </button>
        `}
      `}

      ${displayEmail.attachments?.length > 0 && html`
        <div style="padding: 8px 4px; border-top: 1px solid var(--border);">
          <div style="color: var(--dim-text); font-size: 11px; margin-bottom: 8px;">
            attachments (${displayEmail.attachments.length})
          </div>
          ${displayEmail.attachments.map(att => html`
            <div key=${att.attachmentId} style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">
              <span style="color: var(--mid-text); font-size: 12px;">${att.filename}</span>
              <span style="color: var(--dim-text); font-size: 10px;">(${formatBytes(att.size)})</span>
              <button
                class="btn btn-dashed"
                onClick=${() => handleDownloadAttachment(att.attachmentId, att.filename)}
              >
                download
              </button>
            </div>
          `)}
        </div>
      `}

      <div class="reader-reply-bar">
        <button class="btn btn-action" onClick=${handleReply}>↩ reply</button>
        <button class="btn btn-secondary" onClick=${handleForward}>↪ forward</button>
      </div>
    </div>
  `;
}
