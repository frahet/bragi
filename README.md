# Bragi

> *Norse god of poetry and eloquence — patron of bards, courier of words.*

A Gmail MCP server using **app-password auth**. No OAuth, no browser consent flow, no `credentials.json` to copy between machines. Just two env vars and an IMAP/SMTP connection.

## Why

Most Gmail MCP servers expose Gmail via the Gmail HTTP API, which forces you through Google's OAuth desktop-app flow:

1. Create a GCP project, enable Gmail API
2. Create an OAuth 2.0 desktop client, download `gcp-oauth.keys.json`
3. Run an interactive auth command — browser opens, you click through consent
4. A `credentials.json` file lands on disk with refresh + access tokens
5. Now copy that file to wherever your MCP server is going to actually run (containers, servers, other machines…)

For a single-user dev setup or a containerised agent stack (where there's no browser and no easy way to scp tokens around), that's friction every time. App passwords replace the whole flow with one 16-character string you generate once at [Google Account → Security → App passwords](https://myaccount.google.com/apppasswords) and inject as an env var.

## What you get

Five tools over MCP stdio, ready for Claude Code, Claude Desktop, Cursor, Continue, openclaw, or any MCP client:

| Tool | What it does |
|---|---|
| `list_inbox` | Most recent N messages in INBOX (subject, from, date, UID, unread flag). Optional `unread_only`. |
| `read_message` | Full headers + plain-text body of one message by UID. |
| `search` | Gmail query syntax (`from:bob has:attachment`, `subject:invoice newer_than:7d`, `is:unread`) via X-GM-RAW. |
| `send_email` | Send a new message (to / cc / subject / body). |
| `send_reply` | Reply to a message by UID, preserving `In-Reply-To` + `References` so the thread stays intact. |

UID-based addressing means once the model has seen a list, it can read or reply to anything in that list without re-searching.

## Install + run

```bash
# Run via npx (no install)
GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx npx -y bragi

# Or install globally
npm install -g bragi
GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx bragi
```

Whitespace inside `GMAIL_APP_PASSWORD` is stripped automatically — Google sometimes shows the password as `xxxx xxxx xxxx xxxx`, you can paste it as-is.

## MCP client wiring

### Claude Code (`~/.claude.json` or project `.mcp.json`)

```json
{
  "mcpServers": {
    "bragi": {
      "command": "npx",
      "args": ["-y", "bragi"],
      "env": {
        "GMAIL_USER": "you@gmail.com",
        "GMAIL_APP_PASSWORD": "xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

Identical to the above.

### Container / openclaw / Cursor

The server reads its config from `process.env`. Set `GMAIL_USER` + `GMAIL_APP_PASSWORD` in the container/process env (via `envault run --`, Docker `--env-file`, k8s Secrets, etc.) and don't repeat them inside the MCP client config — the spawned child process inherits them.

Optional overrides (default to Gmail):

```
IMAP_HOST=imap.gmail.com   # default
IMAP_PORT=993              # default
SMTP_HOST=smtp.gmail.com   # default
SMTP_PORT=465              # default (uses TLS)
```

Anything that speaks IMAP+SMTP with these auth semantics works (Fastmail, ProtonMail Bridge, self-hosted dovecot, etc.) — the name says Gmail because that's the original target.

## Why app password is OK

App passwords are scoped credentials issued by Google specifically for legacy IMAP/SMTP/etc. They:

- Require 2FA enabled on the Google account before they can be created
- Can be revoked individually at any time without changing your account password
- Have no effect on browser sessions, OAuth-issued tokens, or other app passwords
- Are bound to your account but cannot be used to change account settings, delete email, or access non-mail data

For a personal-account agent reading your own inbox, this is the right trade-off. For workspace/enterprise tenants where IT controls auth, you'll want OAuth instead — use one of the OAuth-based MCP servers ([gongrzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server), [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)).

## Security posture

- **Credentials never logged.** No `console.log` of the password, no debug mode that prints auth args.
- **Reply HTML is escaped.** When body content reaches `send_reply`, it's sent as `text/plain` only — no HTML injection vector.
- **No file persistence.** Bragi is stateless; nothing about your mail is written to disk.
- **TLS required.** `IMAP_SECURE` and `SMTP_SECURE` default true; downgrade requires explicit env override.
- **Send-rate is your responsibility.** Bragi has no built-in rate limiter — Gmail's own per-account quotas apply (currently 500 recipients/day for personal). Add a wrapper if you need rate-shaping.

## Status

v0.1 — works for the original use case (single Gmail account, agent reading + replying via Telegram bot through openclaw). Issues + PRs welcome, especially:

- Attachment support (parse + download tool)
- Label management (list / apply / remove)
- IMAP IDLE for push notifications (let an agent react to incoming mail)
- Multi-account (multiple `GMAIL_USER_*` / `GMAIL_APP_PASSWORD_*` env pairs)
- Tests

## Prior art

- [yunfeizhu/mcp-mail-server](https://github.com/yunfeizhu/mcp-mail-server) — also IMAP/SMTP, Cursor-targeted, generic email
- [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) — OAuth, Gmail API, more features
- [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) — IMAP/SMTP + IDLE watcher + analytics, LGPL

Bragi exists because we wanted: minimum dependencies, MIT license, no OAuth surface to manage, container-friendly, code small enough to read in 15 minutes.

## License

MIT.
