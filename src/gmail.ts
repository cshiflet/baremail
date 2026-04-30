import { getAccessToken } from './auth.js';
import type { GmailMessage, GmailAttachment, GmailLabel, GmailThread } from './types.js';

const API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://www.googleapis.com/batch/gmail/v1';
const API_PATH_PREFIX = '/gmail/v1/users/me';

let totalBytesTransferred = 0;

export function getTotalBytes(): number {
  return totalBytesTransferred;
}

// Max retries for transient 429 / 5xx responses. Backoff is exponential
// starting at 500ms (500, 1000, 2000, 4000).
const FETCH_RETRY_LIMIT = 4;

async function gmailFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const method = (options.method || 'GET').toUpperCase();
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= FETCH_RETRY_LIMIT; attempt++) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    lastResponse = response;

    // Count bytes only on the final, kept response.
    const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (response.ok || !isRetryable || attempt === FETCH_RETRY_LIMIT) {
      if (method === 'GET') {
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          totalBytesTransferred += parseInt(contentLength, 10);
        } else {
          const buf = await response.clone().arrayBuffer();
          totalBytesTransferred += buf.byteLength;
        }
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gmail API error ${response.status}: ${text}`);
      }
      return response;
    }

    // Drain body so the connection can be reused; ignore any errors.
    try { await response.text(); } catch { /* ignore */ }
    const delay = 500 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }
  // Unreachable in practice, but satisfies the type checker.
  throw new Error(`Gmail API error ${lastResponse?.status ?? 0}: max retries exceeded`);
}

// ── Batch ──

export interface BatchSubRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  // Path relative to /gmail/v1/users/me — e.g., '/messages/abc?format=metadata'.
  path: string;
  // Optional JSON body for non-GET requests.
  body?: unknown;
}

export interface BatchSubResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
  rawBody: string;
}

// Send many Gmail sub-requests as a single multipart/mixed batch. Counts as
// one concurrent request server-side regardless of the number of sub-requests
// (Gmail caps batches at 100, recommends ≤50). Outer request is retried on
// 429/5xx with exponential backoff to match gmailFetch behavior, and any
// sub-requests that come back 429 / 5xx are themselves re-batched with
// backoff so transient bursts caused by rapid scrolling don't surface.
export async function batchGmail<T = unknown>(
  requests: BatchSubRequest[],
): Promise<BatchSubResult<T>[]> {
  if (requests.length === 0) return [];
  if (requests.length > 50) {
    console.warn(`[baremail] batch size ${requests.length} exceeds Gmail's recommended max of 50`);
  }

  const results = await sendOneBatch<T>(requests);

  // Retry sub-requests that returned 429/5xx. Each retry pass re-batches
  // only the failed indices with exponential backoff, until none remain or
  // we hit the retry limit.
  for (let attempt = 0; attempt < FETCH_RETRY_LIMIT; attempt++) {
    const failedIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.ok && (r.status === 429 || (r.status >= 500 && r.status < 600))) {
        failedIndices.push(i);
      }
    }
    if (failedIndices.length === 0) break;
    const delay = 500 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
    const retryRequests = failedIndices.map(i => requests[i]);
    const retryResults = await sendOneBatch<T>(retryRequests);
    for (let i = 0; i < failedIndices.length; i++) {
      results[failedIndices[i]] = retryResults[i];
    }
  }

  return results;
}

// One batch round-trip without sub-request retry. The OUTER request still
// retries on 429/5xx of the batch endpoint itself.
async function sendOneBatch<T>(requests: BatchSubRequest[]): Promise<BatchSubResult<T>[]> {
  const token = await getAccessToken();
  const boundary = `baremail_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const lines: string[] = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const method = req.method || 'GET';
    const fullPath = `${API_PATH_PREFIX}${req.path}`;
    lines.push(`--${boundary}`);
    lines.push('Content-Type: application/http');
    lines.push(`Content-ID: <item${i}>`);
    lines.push('');
    if (req.body !== undefined) {
      const bodyStr = JSON.stringify(req.body);
      lines.push(`${method} ${fullPath}`);
      lines.push('Content-Type: application/json');
      lines.push(`Content-Length: ${bodyStr.length}`);
      lines.push('');
      lines.push(bodyStr);
    } else {
      lines.push(`${method} ${fullPath}`);
      lines.push('');
    }
  }
  lines.push(`--${boundary}--`);
  lines.push('');
  const requestBody = lines.join('\r\n');

  let response: Response | null = null;
  let responseText = '';
  for (let attempt = 0; attempt <= FETCH_RETRY_LIMIT; attempt++) {
    response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      },
      body: requestBody,
    });
    const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (response.ok || !isRetryable || attempt === FETCH_RETRY_LIMIT) {
      responseText = await response.text();
      break;
    }
    try { await response.text(); } catch { /* ignore */ }
    const delay = 500 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }

  if (!response || !response.ok) {
    throw new Error(`Gmail batch error ${response?.status ?? 0}: ${responseText.slice(0, 500)}`);
  }

  totalBytesTransferred += new Blob([responseText]).size;

  const ctype = response.headers.get('content-type') || '';
  const boundaryMatch = ctype.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw new Error('Gmail batch: response missing boundary');
  const respBoundary = boundaryMatch[1].replace(/^"|"$/g, '');

  return parseBatchResponse<T>(responseText, respBoundary, requests.length);
}

function parseBatchResponse<T>(body: string, boundary: string, expectedCount: number): BatchSubResult<T>[] {
  const results: Array<BatchSubResult<T> | null> = new Array(expectedCount).fill(null);
  const sep = `--${boundary}`;
  const parts = body.split(sep);

  for (const partRaw of parts) {
    const part = partRaw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!part || part.startsWith('--')) continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const partHeaders = part.slice(0, headerEnd);
    const httpResponse = part.slice(headerEnd + 4);

    const idMatch = partHeaders.match(/Content-ID:\s*<response-item(\d+)>/i);
    if (!idMatch) continue;
    const idx = parseInt(idMatch[1], 10);

    const innerHeaderEnd = httpResponse.indexOf('\r\n\r\n');
    if (innerHeaderEnd === -1) continue;
    const statusAndHeaders = httpResponse.slice(0, innerHeaderEnd);
    const innerBody = httpResponse.slice(innerHeaderEnd + 4);

    const firstLine = statusAndHeaders.split('\r\n')[0] || '';
    const statusMatch = firstLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    let parsed: T | null = null;
    try {
      const trimmed = innerBody.trim();
      if (trimmed) parsed = JSON.parse(trimmed) as T;
    } catch { /* keep null on non-JSON / parse failure */ }

    results[idx] = {
      status,
      ok: status >= 200 && status < 300,
      body: parsed,
      rawBody: innerBody,
    };
  }

  for (let i = 0; i < expectedCount; i++) {
    if (!results[i]) {
      results[i] = { status: 0, ok: false, body: null, rawBody: 'missing batch sub-response' };
    }
  }
  return results as BatchSubResult<T>[];
}

// ── List messages ──

interface ListResult {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export async function listMessages(
  query?: string,
  pageToken?: string,
  labelIds?: string[],
  maxResults = 25
): Promise<ListResult> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate',
  });

  if (query) params.set('q', query);
  if (pageToken) params.set('pageToken', pageToken);
  if (labelIds?.length) {
    for (const id of labelIds) params.append('labelIds', id);
  }

  const response = await gmailFetch(`/messages?${params}`);
  const data = await response.json();

  return {
    messages: data.messages || [],
    nextPageToken: data.nextPageToken || null,
    resultSizeEstimate: data.resultSizeEstimate || 0,
  };
}

// ── Batch get message metadata ──

async function getMessageMetadata(id: string): Promise<GmailMessage> {
  const fields = 'id,threadId,labelIds,payload(headers),internalDate';

  const response = await gmailFetch(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&fields=${encodeURIComponent(fields)}`
  );
  const data = await response.json();
  return parseMessageData(data);
}

// Concurrent fan-out is bounded so we don't trip Gmail's per-user
// concurrent-request limit (~10). 6 leaves headroom for other in-flight
// calls (label refreshes, etc.).
const BATCH_CONCURRENCY = 6;

export async function batchGetMetadata(
  ids: string[],
  onProgress?: (loaded: number, total: number, messages: GmailMessage[]) => void
): Promise<GmailMessage[]> {
  if (ids.length === 0) return [];

  const results: (GmailMessage | null)[] = new Array(ids.length).fill(null);
  let loadedCount = 0;

  for (let chunkStart = 0; chunkStart < ids.length; chunkStart += BATCH_CONCURRENCY) {
    const chunk = ids.slice(chunkStart, chunkStart + BATCH_CONCURRENCY);
    await Promise.all(chunk.map((id, i) =>
      getMessageMetadata(id).then(msg => {
        results[chunkStart + i] = msg;
        loadedCount++;
        if (onProgress) {
          const loaded = results.filter((r): r is GmailMessage => r !== null);
          onProgress(loadedCount, ids.length, loaded);
        }
      })
    ));
  }
  return results as GmailMessage[];
}

// ── Get single message ──

export async function getMessage(id: string): Promise<GmailMessage> {
  const response = await gmailFetch(
    `/messages/${id}?format=full&fields=${encodeURIComponent(
      'id,threadId,labelIds,payload,internalDate,sizeEstimate'
    )}`
  );
  const data = await response.json();
  return parseMessageData(data, true);
}

// ── Threads ──

interface ListThreadsResult {
  threads: Array<{ id: string; historyId?: string }>;
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export async function listThreads(
  query?: string,
  pageToken?: string,
  labelIds?: string[],
  maxResults = 25
): Promise<ListThreadsResult> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    fields: 'threads(id,historyId),nextPageToken,resultSizeEstimate',
  });

  if (query) params.set('q', query);
  if (pageToken) params.set('pageToken', pageToken);
  if (labelIds?.length) {
    for (const id of labelIds) params.append('labelIds', id);
  }

  const response = await gmailFetch(`/threads?${params}`);
  const data = await response.json();

  return {
    threads: data.threads || [],
    nextPageToken: data.nextPageToken || null,
    resultSizeEstimate: data.resultSizeEstimate || 0,
  };
}

// Sub-request path used by both single and batch fetchers below — keeps the
// fields/format alignment in one place.
const THREAD_METADATA_FIELDS = 'id,historyId,messages(id,threadId,labelIds,payload(headers),internalDate,snippet)';
function threadMetadataPath(id: string): string {
  return `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&fields=${encodeURIComponent(THREAD_METADATA_FIELDS)}`;
}

function parseThreadFromData(data: Record<string, unknown>): GmailThread {
  const messagesRaw = (data.messages || []) as Array<Record<string, unknown>>;
  return {
    id: data.id as string,
    historyId: data.historyId as string | undefined,
    messages: messagesRaw.map(m => parseMessageData(m)),
  };
}

async function getThreadMetadata(id: string): Promise<GmailThread> {
  const response = await gmailFetch(threadMetadataPath(id));
  return parseThreadFromData(await response.json());
}

// Batch up to MAX_PER_BATCH thread.get calls into a single multipart request.
// Gmail allows 100 per batch but recommends ≤50; we use 25 (one inbox page).
const MAX_PER_BATCH = 25;

export async function batchGetThreadMetadata(
  ids: string[],
  onProgress?: (loaded: number, total: number, threads: GmailThread[]) => void
): Promise<GmailThread[]> {
  if (ids.length === 0) return [];

  const results: (GmailThread | null)[] = new Array(ids.length).fill(null);
  let loadedCount = 0;

  for (let chunkStart = 0; chunkStart < ids.length; chunkStart += MAX_PER_BATCH) {
    const chunk = ids.slice(chunkStart, chunkStart + MAX_PER_BATCH);
    const subResults = await batchGmail<Record<string, unknown>>(
      chunk.map(id => ({ method: 'GET' as const, path: threadMetadataPath(id) })),
    );
    for (let i = 0; i < subResults.length; i++) {
      const r = subResults[i];
      if (r.ok && r.body) {
        results[chunkStart + i] = parseThreadFromData(r.body);
      } else {
        console.warn(`[baremail] batch thread fetch failed for ${chunk[i]}: ${r.status} ${r.rawBody.slice(0, 200)}`);
      }
      loadedCount++;
    }
    if (onProgress) {
      const loaded = results.filter((t): t is GmailThread => t !== null);
      onProgress(loadedCount, ids.length, loaded);
    }
  }
  return results.filter((t): t is GmailThread => t !== null);
}

export async function getThread(id: string): Promise<GmailThread> {
  const fields = 'id,historyId,messages(id,threadId,labelIds,payload,internalDate,sizeEstimate,snippet)';
  const response = await gmailFetch(
    `/threads/${id}?format=full&fields=${encodeURIComponent(fields)}`
  );
  const data = await response.json();
  const messagesRaw = (data.messages || []) as Array<Record<string, unknown>>;
  return {
    id: data.id as string,
    historyId: data.historyId as string | undefined,
    messages: messagesRaw.map(m => parseMessageData(m, true)),
  };
}

// Thread-level modify / archive / trash. Applied to every message in the thread.
export async function modifyThread(
  id: string,
  addLabelIds?: string[],
  removeLabelIds?: string[]
): Promise<void> {
  const body: Record<string, string[]> = {};
  if (addLabelIds?.length) body.addLabelIds = addLabelIds;
  if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds;

  await gmailFetch(`/threads/${id}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function archiveThread(id: string): Promise<void> {
  await modifyThread(id, undefined, ['INBOX']);
}

export async function trashThread(id: string): Promise<void> {
  await gmailFetch(`/threads/${id}/trash`, { method: 'POST' });
}

// ── Send message ──

function wrapLongLines(text: string, maxLen = 76): string {
  return text.split('\n').map(line => {
    if (line.length <= maxLen) return line;
    const chunks: string[] = [];
    let i = 0;
    while (i < line.length) {
      let breakAt = -1;
      const end = Math.min(i + maxLen, line.length);
      for (let j = end - 1; j > i; j--) {
        if (line[j] === ' ') { breakAt = j; break; }
      }
      if (breakAt === -1 || breakAt === i) {
        chunks.push(line.slice(i, end));
        i = end;
      } else {
        chunks.push(line.slice(i, breakAt));
        i = breakAt + 1;
      }
    }
    return chunks.join('\n');
  }).join('\n');
}

export interface SendAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
}

export async function sendMessage(
  to: string,
  subject: string,
  body: string,
  options?: {
    cc?: string;
    bcc?: string;
    threadId?: string;
    inReplyTo?: string;
    attachments?: SendAttachment[];
  }
): Promise<string> {
  const hasAttachments = options?.attachments && options.attachments.length > 0;
  const boundary = `baremail_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headers: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];

  if (options?.cc) headers.push(`Cc: ${options.cc}`);
  if (options?.bcc) headers.push(`Bcc: ${options.bcc}`);
  if (options?.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
    headers.push(`References: ${options.inReplyTo}`);
  }

  const wrappedBody = wrapLongLines(body);
  let raw: string;

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      wrappedBody,
    ];

    for (const att of options!.attachments!) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.name}"`,
        `Content-Disposition: attachment; filename="${att.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        att.data,
      );
    }

    parts.push(`--${boundary}--`);
    raw = parts.join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    raw = headers.join('\r\n') + '\r\n\r\n' + wrappedBody;
  }

  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const payload: Record<string, unknown> = { raw: encoded };
  if (options?.threadId) payload.threadId = options.threadId;

  const response = await gmailFetch('/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return data.id;
}

// ── Modify message (labels, read/unread) ──

export async function modifyMessage(
  id: string,
  addLabelIds?: string[],
  removeLabelIds?: string[]
): Promise<void> {
  const body: Record<string, string[]> = {};
  if (addLabelIds?.length) body.addLabelIds = addLabelIds;
  if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds;

  await gmailFetch(`/messages/${id}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function markAsRead(id: string): Promise<void> {
  await modifyMessage(id, undefined, ['UNREAD']);
}

export async function markAsUnread(id: string): Promise<void> {
  await modifyMessage(id, ['UNREAD']);
}

export async function archiveMessage(id: string): Promise<void> {
  await modifyMessage(id, undefined, ['INBOX']);
}

export async function starMessage(id: string): Promise<void> {
  await modifyMessage(id, ['STARRED']);
}

export async function unstarMessage(id: string): Promise<void> {
  await modifyMessage(id, undefined, ['STARRED']);
}

export async function trashMessage(id: string): Promise<void> {
  await gmailFetch(`/messages/${id}/trash`, { method: 'POST' });
}

// ── Labels ──

function parseLabel(data: Record<string, unknown>): GmailLabel {
  const color = data.color as { textColor?: string; backgroundColor?: string } | undefined;
  return {
    id: data.id as string,
    name: data.name as string,
    type: data.type as string,
    messagesTotal: data.messagesTotal as number | undefined,
    messagesUnread: data.messagesUnread as number | undefined,
    color: color && (color.textColor || color.backgroundColor)
      ? { textColor: color.textColor, backgroundColor: color.backgroundColor }
      : undefined,
  };
}

// Slim list. Gmail's labels.list omits messagesTotal/messagesUnread; those
// require labels.get per label. We avoid fetching counts here so users with
// many labels don't trip the per-user concurrent-request limit (429).
export async function listLabels(): Promise<GmailLabel[]> {
  const response = await gmailFetch('/labels?fields=labels(id,name,type,color)');
  const data = await response.json();
  return ((data.labels || []) as Array<Record<string, unknown>>).map(parseLabel);
}

// Fetch a single label including counts. Caller is responsible for not
// firing too many of these in parallel.
export async function getLabel(id: string): Promise<GmailLabel> {
  const response = await gmailFetch(
    `/labels/${id}?fields=id,name,type,messagesTotal,messagesUnread,color`
  );
  return parseLabel(await response.json());
}

// Fetch counts for the specified label ids sequentially, merge them into the
// supplied label list, and return a new array. Sequential to keep Gmail's
// concurrent-request limit happy on accounts with many labels in flight.
export async function enrichLabelsWithCounts(
  labels: GmailLabel[],
  ids: string[],
): Promise<GmailLabel[]> {
  if (ids.length === 0) return labels;
  const enriched = [...labels];
  for (const id of ids) {
    try {
      const detailed = await getLabel(id);
      const idx = enriched.findIndex(l => l.id === id);
      if (idx !== -1) enriched[idx] = detailed;
      else enriched.push(detailed);
    } catch (err) {
      console.warn(`[baremail] failed to fetch counts for label ${id}:`, err);
    }
  }
  return enriched;
}

// ── Parse helpers ──

function parseMessageData(data: Record<string, unknown>, full = false): GmailMessage {
  const payload = data.payload as Record<string, unknown> | undefined;
  const headers = (payload?.headers || []) as Array<{ name: string; value: string }>;
  const labelIds = (data.labelIds || []) as string[];

  const getHeader = (name: string) =>
    headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const fromRaw = getHeader('From');
  const fromMatch = fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const fromName = fromMatch?.[1]?.trim() || fromRaw;
  const fromEmail = fromMatch?.[2]?.trim() || fromRaw;

  let body = '';
  let bodyHtml = '';
  const attachments: GmailAttachment[] = [];

  if (full && payload) {
    const result = extractParts(payload, data.id as string);
    body = result.plain;
    bodyHtml = result.html;
    attachments.push(...result.attachments);

    if (bodyHtml && (!body || body.trim().length < 20)) {
      body = htmlToPlainText(bodyHtml);
    }

    body = body.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return {
    id: data.id as string,
    threadId: data.threadId as string,
    labelIds,
    from: fromEmail,
    fromName,
    to: getHeader('To'),
    cc: getHeader('Cc'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    internalDate: parseInt(data.internalDate as string, 10) || 0,
    snippet: (data.snippet as string) || '',
    body,
    bodyHtml,
    isUnread: labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    sizeEstimate: (data.sizeEstimate as number) || 0,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

function htmlToPlainText(htmlStr: string): string {
  try {
    const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
    doc.querySelectorAll('style, script, head, noscript').forEach(el => el.remove());
    doc.querySelectorAll('img').forEach(el => {
      const w = el.getAttribute('width');
      const h = el.getAttribute('height');
      if ((w === '1' || w === '0') && (h === '1' || h === '0')) el.remove();
    });
    doc.querySelectorAll('[style]').forEach(el => {
      const s = (el.getAttribute('style') || '').toLowerCase();
      if (s.includes('display:none') || s.includes('display: none')) el.remove();
    });

    const blockTags = new Set([
      'div', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'tr', 'blockquote', 'section', 'article', 'hr', 'pre',
      'table', 'thead', 'tbody', 'tfoot',
    ]);

    const parts: string[] = [];
    let lastWasBlock = false;

    function walk(node: Node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').replace(/\s+/g, ' ');
        if (text.trim()) {
          parts.push(text);
          lastWasBlock = false;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === 'hr') { parts.push('\n────────────────────────────\n'); lastWasBlock = true; return; }

      if (tag === 'a' && el.getAttribute('href')) {
        const href = el.getAttribute('href')!;
        let linkText = el.textContent?.trim() || '';
        if (!linkText) {
          linkText = el.getAttribute('title')?.trim() || '';
        }
        if (!linkText) {
          for (const img of Array.from(el.querySelectorAll('img'))) {
            const alt = img.getAttribute('alt')?.trim() || '';
            if (alt) { linkText = alt; break; }
          }
        }
        if (!linkText) linkText = 'link';
        if (linkText !== href) {
          parts.push(`${linkText} [${href}]`);
        } else {
          parts.push(href);
        }
        lastWasBlock = false;
        return;
      }

      const isBlock = blockTags.has(tag);
      if (isBlock && !lastWasBlock && parts.length > 0) {
        parts.push('\n');
        lastWasBlock = true;
      }

      for (const child of el.childNodes) walk(child);

      if (isBlock && !lastWasBlock) {
        parts.push('\n');
        lastWasBlock = true;
      }
    }

    walk(doc.body);
    return parts.join('')
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return htmlStr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

interface ExtractResult {
  plain: string;
  html: string;
  attachments: GmailAttachment[];
}

function extractParts(payload: Record<string, unknown>, messageId: string): ExtractResult {
  const result: ExtractResult = { plain: '', html: '', attachments: [] };
  const mimeType = payload.mimeType as string || '';

  if (mimeType === 'text/plain' && payload.body) {
    const bodyData = (payload.body as Record<string, unknown>).data as string;
    if (bodyData) result.plain = decodeBase64Url(bodyData);
  } else if (mimeType === 'text/html' && payload.body) {
    const bodyData = (payload.body as Record<string, unknown>).data as string;
    if (bodyData) result.html = decodeBase64Url(bodyData);
  }

  if (payload.filename && (payload.filename as string).length > 0) {
    const body = payload.body as Record<string, unknown> | undefined;
    result.attachments.push({
      filename: payload.filename as string,
      mimeType,
      size: (body?.size as number) || 0,
      attachmentId: (body?.attachmentId as string) || '',
      messageId,
    });
  }

  const parts = (payload.parts || []) as Array<Record<string, unknown>>;
  for (const part of parts) {
    const sub = extractParts(part, messageId);
    if (!result.plain && sub.plain) result.plain = sub.plain;
    if (!result.html && sub.html) result.html = sub.html;
    result.attachments.push(...sub.attachments);
  }

  return result;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
  } catch {
    try {
      return atob(base64);
    } catch {
      return data;
    }
  }
}

// ── Download attachment ──

export async function getAttachment(messageId: string, attachmentId: string): Promise<Blob> {
  const response = await gmailFetch(
    `/messages/${messageId}/attachments/${attachmentId}`
  );
  const data = await response.json();
  const base64 = (data.data as string).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}
