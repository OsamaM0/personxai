/**
 * Gmail: search, read, and send.
 *
 * The assistant reads mail to answer questions about it; it never deletes and
 * never modifies labels beyond marking a message read on request. Bodies are
 * flattened to plain text and truncated, because a turn only needs enough to
 * summarise — not a whole newsletter.
 */
import { decodeBase64Url, encodeBase64Url, googleFetch } from "./api";
import { truncate } from "../../utils/text";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Enough to answer "what did they say?"; the model gets a summary, not an archive. */
const MAX_BODY_CHARS = 4000;

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
}

export interface MailMessage extends MailSummary {
  body: string;
  bodyTruncated: boolean;
}

const headerOf = (payload: GmailPart | undefined, name: string): string => {
  const wanted = name.toLowerCase();
  for (const h of payload?.headers ?? []) {
    if (h.name?.toLowerCase() === wanted) return h.value ?? "";
  }
  return "";
};

/** Walk the MIME tree for the best text we can show, preferring text/plain. */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: GmailPart) => {
    const data = part.body?.data;
    if (data && !part.filename) {
      if (part.mimeType === "text/plain") plain.push(decodeBase64Url(data));
      else if (part.mimeType === "text/html") html.push(decodeBase64Url(data));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  if (plain.length > 0) return plain.join("\n").trim();
  if (html.length === 0) return "";
  // Crude but adequate de-HTML: the model needs the words, not the markup.
  return html
    .join("\n")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasAttachments(payload: GmailPart | undefined): boolean {
  if (!payload) return false;
  if (payload.filename && payload.body?.attachmentId) return true;
  return (payload.parts ?? []).some(hasAttachments);
}

function toSummary(msg: GmailMessage): MailSummary {
  const date = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : headerOf(msg.payload, "date");
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: headerOf(msg.payload, "from"),
    to: headerOf(msg.payload, "to"),
    subject: headerOf(msg.payload, "subject") || "(no subject)",
    date,
    snippet: msg.snippet ?? "",
    unread: (msg.labelIds ?? []).includes("UNREAD"),
    hasAttachments: hasAttachments(msg.payload),
  };
}

/**
 * Search mail with Gmail's own query syntax ("is:unread from:sara newer_than:7d").
 * Metadata only — bodies are fetched one at a time by `readMail`, so a search of
 * twenty messages does not pull twenty message bodies through the worker.
 */
export async function searchMail(
  accessToken: string,
  opts: { query?: string; limit?: number; labelIds?: string[] } = {}
): Promise<MailSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const list = await googleFetch<{ messages?: { id: string }[] }>(
    accessToken,
    "gmail.messages.list",
    `${BASE}/messages`,
    {
      query: {
        maxResults: limit,
        q: opts.query,
        ...(opts.labelIds?.length ? { labelIds: opts.labelIds.join(",") } : {}),
      },
    }
  );
  const ids = (list.messages ?? []).slice(0, limit).map((m) => m.id);
  if (ids.length === 0) return [];

  const messages = await Promise.all(
    ids.map((id) =>
      googleFetch<GmailMessage>(accessToken, "gmail.messages.get", `${BASE}/messages/${id}`, {
        // metadata format skips the body entirely — much less to transfer.
        query: { format: "metadata" },
      }).catch(() => null)
    )
  );
  return messages.filter((m): m is GmailMessage => m !== null).map(toSummary);
}

/** One message, with its body flattened to text and capped. */
export async function readMail(accessToken: string, messageId: string): Promise<MailMessage> {
  const msg = await googleFetch<GmailMessage>(
    accessToken,
    "gmail.messages.get",
    `${BASE}/messages/${messageId}`,
    { query: { format: "full" } }
  );
  const body = extractBody(msg.payload);
  return {
    ...toSummary(msg),
    body: truncate(body, MAX_BODY_CHARS),
    bodyTruncated: body.length > MAX_BODY_CHARS,
  };
}

/** RFC 5322 header values must not carry raw newlines — that is header injection. */
const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/**
 * Non-ASCII subjects need RFC 2047 encoded-words, or Gmail shows mojibake for
 * anything Arabic — which is half of what this assistant writes.
 */
function encodeHeaderValue(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${encodeBase64Url(safe).replace(/-/g, "+").replace(/_/g, "/")}=?`;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  /** Reply into an existing thread; pass the thread id from a search result. */
  threadId?: string;
  /** Message-Id of the mail being answered, so clients thread it properly. */
  inReplyTo?: string;
}

/** Compose and send. Returns the new message's id and thread. */
export async function sendMail(
  accessToken: string,
  input: SendMailInput
): Promise<{ id: string; threadId: string }> {
  const lines = [
    `To: ${headerSafe(input.to)}`,
    ...(input.cc ? [`Cc: ${headerSafe(input.cc)}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${headerSafe(input.inReplyTo)}`, `References: ${headerSafe(input.inReplyTo)}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ];
  const result = await googleFetch<{ id?: string; threadId?: string }>(
    accessToken,
    "gmail.messages.send",
    `${BASE}/messages/send`,
    {
      method: "POST",
      body: {
        raw: encodeBase64Url(lines.join("\r\n")),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    }
  );
  return { id: result.id ?? "", threadId: result.threadId ?? "" };
}

/** Clear the UNREAD label — the only mutation the assistant makes to a mailbox. */
export async function markMailRead(accessToken: string, messageId: string): Promise<void> {
  await googleFetch(accessToken, "gmail.messages.modify", `${BASE}/messages/${messageId}/modify`, {
    method: "POST",
    body: { removeLabelIds: ["UNREAD"] },
  });
}

/** Unread count, for the daily brief and the dashboard card. */
export async function unreadCount(accessToken: string): Promise<number> {
  const label = await googleFetch<{ messagesUnread?: number }>(
    accessToken,
    "gmail.labels.get",
    `${BASE}/labels/INBOX`
  );
  return label.messagesUnread ?? 0;
}
