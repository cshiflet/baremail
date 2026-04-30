import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import DOMPurify from 'dompurify';
import type { ConnectionStatus, GmailLabel } from '../types.js';

const html = htm.bind(h);

export type LinkMode = 'labeled' | 'url';

const A_TAG_RE = /<a\s+[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
const LABELED_RE = /(\S(?:(?!:\/\/)[^\[\n]){0,79}?(?<=\S)) \[(https?:\/\/[^\]\s]+)\]/g;
const URL_RE = /https?:\/\/[^\s<>"\])]+/g;

export function linkifyBody(text: string, mode: LinkMode): any[] {
  if (!text) return [];

  // Pass 1: <a href="X">Y</a> → clickable Y. In url mode, also show X if it differs.
  const stage1: any[] = [];
  let last = 0;
  A_TAG_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = A_TAG_RE.exec(text)) !== null; ) {
    if (m.index > last) stage1.push(text.slice(last, m.index));
    const href = m[2];
    const label = m[3] || href;
    stage1.push(html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>`);
    if (mode === 'url' && label !== href) {
      stage1.push(' [');
      stage1.push(html`<a href=${href} target="_blank" rel="noopener noreferrer">${href}</a>`);
      stage1.push(']');
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) stage1.push(text.slice(last));

  // Pass 2: "label [url]" pattern from htmlToPlainText.
  const stage2: any[] = [];
  for (const seg of stage1) {
    if (typeof seg !== 'string') {
      stage2.push(seg);
      continue;
    }
    let s = 0;
    LABELED_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = LABELED_RE.exec(seg)) !== null; ) {
      const label = m[1];
      const url = m[2];
      if (m.index > s) stage2.push(seg.slice(s, m.index));
      if (mode === 'labeled') {
        stage2.push(html`<a href=${url} target="_blank" rel="noopener noreferrer">${label}</a>`);
      } else {
        stage2.push(label + ' [');
        stage2.push(html`<a href=${url} target="_blank" rel="noopener noreferrer">${url}</a>`);
        stage2.push(']');
      }
      s = m.index + m[0].length;
    }
    if (s < seg.length) stage2.push(seg.slice(s));
  }

  // Pass 3: bare URLs.
  const result: any[] = [];
  for (const seg of stage2) {
    if (typeof seg !== 'string') {
      result.push(seg);
      continue;
    }
    let s = 0;
    URL_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = URL_RE.exec(seg)) !== null; ) {
      let url = m[0];
      let trail = '';
      while (url.length > 0 && /[.,;:!?]$/.test(url)) {
        trail = url.slice(-1) + trail;
        url = url.slice(0, -1);
      }
      if (m.index > s) result.push(seg.slice(s, m.index));
      const displayText = mode === 'labeled' ? '[link]' : url;
      result.push(html`<a href=${url} target="_blank" rel="noopener noreferrer">${displayText}</a>`);
      if (trail) result.push(trail);
      s = m.index + m[0].length;
    }
    if (s < seg.length) result.push(seg.slice(s));
  }

  return result;
}

export interface PreparedEmailHtml {
  html: string;
  deferredCount: number;
}

// Sanitize HTML and defer external <img> loading. The src on each external
// image is moved to data-baremail-src so the browser doesn't fetch it; a
// later call to loadDeferredImages restores the src after explicit user
// consent. Inline data: and cid: image URLs are left alone.
export function prepareEmailHtml(htmlInput: string): PreparedEmailHtml {
  const sanitized = DOMPurify.sanitize(htmlInput, {
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    ALLOW_DATA_ATTR: false,
  });
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  let deferredCount = 0;
  doc.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('cid:')) return;
    img.setAttribute('data-baremail-src', src);
    img.removeAttribute('src');
    deferredCount++;
  });
  return { html: doc.body.innerHTML, deferredCount };
}

export function loadDeferredImages(root: Element | null): void {
  if (!root) return;
  root.querySelectorAll('img[data-baremail-src]').forEach(img => {
    const src = (img as HTMLImageElement).dataset.baremailSrc;
    if (src) {
      (img as HTMLImageElement).src = src;
      img.removeAttribute('data-baremail-src');
    }
  });
}

export function LabelChip({ label, useColor }: { label: GmailLabel; useColor: boolean }) {
  const accent = label.color?.backgroundColor || label.color?.textColor;
  const style = useColor && accent
    ? `color: ${accent}; border-color: ${accent}; background: transparent;`
    : '';
  return html`<span class="label-chip" style=${style} title=${label.name}>${label.name}</span>`;
}

export function LabelChips({ messageLabelIds, allLabels, useColor }: {
  messageLabelIds: string[] | undefined;
  allLabels: GmailLabel[];
  useColor: boolean;
}) {
  if (!messageLabelIds || messageLabelIds.length === 0) return null;
  const userLabelIds = new Set(allLabels.filter(l => l.type === 'user').map(l => l.id));
  const chips = messageLabelIds
    .filter(id => userLabelIds.has(id))
    .map(id => allLabels.find(l => l.id === id))
    .filter((l): l is GmailLabel => !!l)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (chips.length === 0) return null;
  return html`<span class="label-chips">${chips.map(label => html`<${LabelChip} key=${label.id} label=${label} useColor=${useColor} />`)}</span>`;
}

export function StatusDot({ status }: { status: ConnectionStatus }) {
  return html`<span class="status-dot ${status}" />`;
}

export function TypewriterText({ text, speed = 30 }: { text: string; speed?: number }) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
        setDone(true);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);

  return html`
    <span>
      ${displayed}
      ${!done && html`<span class="cursor-blink">▌</span>`}
    </span>
  `;
}

export function KeyHint({ keys, label }: { keys: string; label: string }) {
  return html`
    <span class="key-hint">
      <span class="key-hint-key">${keys}</span>
      ${label}
    </span>
  `;
}

export function Loading({ message = 'fetching mail...' }: { message?: string }) {
  return html`
    <div class="loading fade-in">
      <div class="loading-bear">ʕ·ᴥ·ʔ</div>
      <div>${message}</div>
    </div>
  `;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatDate(internalDate: number): string {
  const d = new Date(internalDate);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  if (isToday) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatFullDate(internalDate: number): string {
  const d = new Date(internalDate);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
