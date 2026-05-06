#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

const env = (key, fallback) => {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env: ${key}`);
};

const GMAIL_USER = env("GMAIL_USER");
const GMAIL_APP_PASSWORD = env("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
const IMAP_HOST = env("IMAP_HOST", "imap.gmail.com");
const IMAP_PORT = parseInt(env("IMAP_PORT", "993"), 10);
const SMTP_HOST = env("SMTP_HOST", "smtp.gmail.com");
const SMTP_PORT = parseInt(env("SMTP_PORT", "465"), 10);

let _imap = null;

async function imap() {
  if (_imap?.usable) return _imap;
  if (_imap) {
    try { await _imap.logout(); } catch { /* ignore */ }
    _imap = null;
  }
  const c = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  await c.connect();
  _imap = c;
  return c;
}

const smtp = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

async function withInbox(fn) {
  const c = await imap();
  const lock = await c.getMailboxLock("INBOX");
  try {
    return await fn(c);
  } finally {
    lock.release();
  }
}

function envelopeToSummary(uid, envelope, flags) {
  return {
    uid,
    subject: envelope?.subject ?? "(no subject)",
    from: envelope?.from?.[0]?.address ?? "(unknown)",
    from_name: envelope?.from?.[0]?.name ?? null,
    date: envelope?.date?.toISOString() ?? null,
    unread: !flags?.has("\\Seen"),
  };
}

async function listInbox(args = {}) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 10));
  return withInbox(async (c) => {
    const criteria = args.unread_only ? { seen: false } : { all: true };
    const uids = await c.search(criteria, { uid: true });
    const recent = uids.slice(-limit).reverse();
    if (recent.length === 0) return [];
    const out = [];
    for await (const msg of c.fetch(
      recent,
      { uid: true, envelope: true, flags: true },
      { uid: true },
    )) {
      out.push(envelopeToSummary(msg.uid, msg.envelope, msg.flags));
    }
    return out;
  });
}

async function readMessage(args) {
  const uid = args.uid;
  if (!uid) throw new Error("Missing required arg: uid");
  return withInbox(async (c) => {
    const msg = await c.fetchOne(
      uid,
      { source: true, envelope: true, flags: true },
      { uid: true },
    );
    if (!msg) throw new Error(`No message with UID ${uid}`);
    const parsed = await simpleParser(msg.source);
    return {
      uid,
      subject: parsed.subject ?? "(no subject)",
      from: parsed.from?.text ?? "(unknown)",
      to: parsed.to?.text ?? null,
      cc: parsed.cc?.text ?? null,
      date: parsed.date?.toISOString() ?? null,
      message_id: parsed.messageId ?? null,
      in_reply_to: parsed.inReplyTo ?? null,
      references: parsed.references
        ? Array.isArray(parsed.references)
          ? parsed.references.join(" ")
          : parsed.references
        : null,
      unread: !msg.flags?.has("\\Seen"),
      body: parsed.text ?? "(no plain text body)",
    };
  });
}

async function search(args) {
  const query = args.query;
  if (!query) throw new Error("Missing required arg: query");
  const limit = Math.max(1, Math.min(100, args.limit ?? 10));
  return withInbox(async (c) => {
    const uids = await c.search({ gmailRaw: query }, { uid: true });
    const recent = uids.slice(-limit).reverse();
    if (recent.length === 0) return [];
    const out = [];
    for await (const msg of c.fetch(
      recent,
      { uid: true, envelope: true, flags: true },
      { uid: true },
    )) {
      out.push(envelopeToSummary(msg.uid, msg.envelope, msg.flags));
    }
    return out;
  });
}

async function sendEmail(args) {
  if (!args.to || !args.subject || !args.body) {
    throw new Error("send_email requires: to, subject, body");
  }
  const info = await smtp.sendMail({
    from: GMAIL_USER,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    text: args.body,
  });
  return {
    ok: true,
    message_id: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

async function sendReply(args) {
  if (!args.uid || !args.body) {
    throw new Error("send_reply requires: uid, body");
  }
  const original = await readMessage({ uid: args.uid });
  const refs = original.references
    ? `${original.references} ${original.message_id}`.trim()
    : original.message_id;
  const subject = original.subject?.startsWith("Re: ")
    ? original.subject
    : `Re: ${original.subject ?? ""}`;
  const info = await smtp.sendMail({
    from: GMAIL_USER,
    to: original.from,
    subject,
    inReplyTo: original.message_id,
    references: refs,
    text: args.body,
  });
  return {
    ok: true,
    message_id: info.messageId,
    replied_to_uid: args.uid,
    subject,
  };
}

const tools = [
  {
    name: "list_inbox",
    description:
      "List recent messages in INBOX. Returns subject, from, date, UID, and unread flag. Use the UID to read or reply to a specific message.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 10,
          description: "Max messages to return (1-100). Default 10.",
        },
        unread_only: {
          type: "boolean",
          default: false,
          description: "If true, only unread messages.",
        },
      },
    },
  },
  {
    name: "read_message",
    description:
      "Fetch full headers and plain-text body of one message by UID. Use list_inbox or search first to obtain the UID.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "Message UID from list_inbox or search." },
      },
      required: ["uid"],
    },
  },
  {
    name: "search",
    description:
      "Search messages with Gmail query syntax (e.g. 'from:bob has:attachment', 'subject:invoice newer_than:7d', 'is:unread', 'label:starred'). Uses Gmail's X-GM-RAW IMAP extension.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail-style query string." },
        limit: { type: "number", default: 10, description: "Max results (1-100)." },
      },
      required: ["query"],
    },
  },
  {
    name: "send_email",
    description: "Send a new email.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address (or comma-separated list).",
        },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text body." },
        cc: {
          type: "string",
          description: "Optional CC recipients (comma-separated).",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_reply",
    description:
      "Reply to an existing message by UID. Preserves In-Reply-To and References headers so the thread stays intact.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "UID of the message being replied to." },
        body: { type: "string", description: "Plain text reply body." },
      },
      required: ["uid", "body"],
    },
  },
];

const handlers = {
  list_inbox: listInbox,
  read_message: readMessage,
  search,
  send_email: sendEmail,
  send_reply: sendReply,
};

const server = new Server(
  { name: "bragi", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const fn = handlers[name];
  if (!fn) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await fn(args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
