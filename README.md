# ChatGoose

A Firefox extension that gives Fansly chatters AI-powered tools for managing DM conversations on behalf of content creators. It intercepts Fansly session data, sends conversation context to the selected AI model, and renders results in an overlay directly on the page.

## Who This Is For

Chatters working at adult content creator agencies who manage multiple Fansly accounts. You sit in DMs all day, replying as the creator, keeping fans engaged, and driving revenue. ChatGoose gives you AI assistance without leaving the Fansly tab.

## Features

### Fast Reply

Generates a reply in the creator's voice based on recent conversation history. The reply appears in an overlay with an **Insert** button that pastes it directly into the Fansly textarea. Supports multi-part replies split by `[NEXT]` markers when "Prefer Split" mode is enabled.

Uses the last ~100 messages (configurable) for context. Quick feature — 60-second timeout.

### Help Me

Coaching mode. Instead of writing a reply for you, it analyzes the conversation and returns:

- **Coaching** — situational read, what went well, mistakes, suggested next move
- **Engaging suggestion** — a rapport-building reply option
- **Flirty suggestion** — a more seductive reply option

Each suggestion has its own Insert button. Quick feature — 60-second timeout.

### Fan Summary

Generates a profile of the fan covering interests, communication style, spending behavior, conversation patterns, and red flags. Uses deep message history (~1500 messages by default, configurable up to 3000) for a thorough read.

Results are cached per conversation. If the personality hasn't changed since the last summary, the cached version is returned instantly. Deep feature — staged timeout guards (180s prep, 45s AI TTFB/idle, 300s max stream).

### Chat Review

Quality review of the chatter's performance with a 1–10 rating. Evaluates persona adherence, conversation quality, specific mistakes, monetization awareness, and fan handling. Returns a rating, evaluation, and recommendations.

Uses deep message history. Deep feature — staged timeout guards (180s prep, 45s AI TTFB/idle, 300s max stream).

### Ping

Generates a reactivation message for fans who've gone quiet. Analyzes the fan's activity to determine a segment:

- **Segment A** (was active, went silent): references past topics to re-engage
- **Segment B** (never really chatted): warm first-impression opener

If the fan has been active in the last 5 days, the ping is blocked — they don't need reactivation. Uses the last ~100 messages (configurable via a dedicated Ping message count setting). Quick feature — 60-second timeout.

## How It Works

```
┌─────────────┐     webRequest      ┌────────────────────┐
│  Fansly.com │ ──────────────────► │  Background Worker  │
│  (browser)  │  intercept headers  │                     │
└─────────────┘                     │  - SessionStore     │
       ▲                            │  - FanslyClient     │
       │  content script            │  - LlmClient        │
       │  (injected)                │  - OperationCoord.  │
       │                            └────────┬───────────┘
┌──────┴──────┐    Port messages         │
│  Button Bar │ ◄──────────────────────► │
│  Overlay UI │    start/cancel/         │
│  Toasts     │    chunks/complete   ┌───┴───────────┐
└─────────────┘                      │  AI provider  │
                                     │  (streaming)  │
                                     └───────────────┘
```

1. **Session capture** — The background worker intercepts requests to `apiv3.fansly.com` via `webRequest.onBeforeSendHeaders`, extracting auth headers. No credentials are stored — they're held in memory for the duration of the browser session.

2. **Content script** — Injected into `fansly.com`. Renders a button bar below the conversation and manages the overlay. Communicates with the background via a long-lived `runtime.Port` with auto-reconnect.

3. **Operation flow** — When you click a feature button, the content script validates prerequisites (API key configured, personality assigned, session connected), then sends an `operation:start` message. The background loads messages from the Fansly API, builds a prompt with the conversation transcript and spending/subscription context, and streams the response from the selected AI provider. Text chunks are batched at 50ms intervals and forwarded to the content script for live rendering.

4. **Overlay** — Results appear in a dark-themed overlay anchored to the conversation. Reply and ping results have Insert buttons. The overlay uses a shell-reuse pattern (outer frame created once, body swapped) and updates text nodes directly during streaming to prevent flicker.

## Setup

### Prerequisites

- Firefox (tested on 128+)
- A Claude API key from [console.anthropic.com](https://console.anthropic.com) for Claude Direct models
- Optional: an OpenRouter API key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) for Gemini/Grok models
- Node.js 18+ and npm

### Build

```bash
npm install
npm run build
```

Output goes to `dist/`.

### Install in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `dist/manifest.json`

The extension icon appears in the toolbar. Navigate to [fansly.com](https://fansly.com) and open a DM conversation — the ChatGoose button bar should appear.

### Enter Your API Keys

1. Click the ChatGoose toolbar icon and choose **Open Settings** (or right-click the icon → Extension Options)
2. Paste your Claude API key for Claude Direct models, and/or your OpenRouter API key for OpenRouter models
3. Keys are stored in `browser.storage.local` and only sent to their matching provider: Claude keys to `api.anthropic.com`, OpenRouter keys to `openrouter.ai`

### AI Models

Settings → **AI Models** lets you choose a model per feature. Claude Direct models continue to use Anthropic. OpenRouter currently supports only this curated whitelist:

- `openrouter:google/gemini-3.1-pro-preview`
- `openrouter:x-ai/grok-4.20`
- `openrouter:x-ai/grok-4.3`

Use `x-ai/grok-4.20` exactly. `x-ai/grok-4.2` is not a supported OpenRouter slug in ChatGoose.

## Configuration

### Personalities

A personality is the voice profile the selected AI model uses when generating replies. Each personality has a name and a content block — free-form instructions describing tone, style, boundaries, and any other behavioral guidance.

In Settings → **Model Personalities**, create one or more personalities. Example:

```
Name: Luna
Content: You are Luna, a playful and flirty 24-year-old. You use casual
texting style with occasional emojis. You're warm but keep boundaries —
never agree to meet IRL. You tease but don't get explicit without the
fan escalating first.
```

### Account Mappings

Each Fansly account the extension sees gets listed in Settings → **Account Mappings**. Assign a personality to each account. Until an account is mapped, the feature buttons will prompt you to assign one.

If you're logged into a new account and the extension detects it via intercepted requests, a mapping banner appears in the conversation view.

### Settings

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Reply + Help message count | 100 | 5–200 | Messages loaded for Reply and Help Me |
| Ping message count | 100 | 5–200 | Messages loaded for Ping |
| Deep message count | 1500 | 100–3000 | Messages loaded for Summary, Chat Review |
| Debug mode | Off | — | Enables verbose logging and prompt inspector in error overlays |

## Development

### Scripts

```bash
npm run build        # Production build → dist/
npm run watch        # Rebuild on file changes
npm test             # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
npm run typecheck    # TypeScript strict check (tsc --noEmit)
```

### Project Structure

```
src/
├── background/          # Service worker — orchestration, API clients, session management
│   ├── index.ts         # Composition root (dependency wiring)
│   ├── llm-client.ts         # Provider routing
│   ├── anthropic-client.ts   # Claude API streaming (SSE)
│   ├── openrouter-client.ts  # OpenRouter Messages API streaming
│   ├── fansly-client.ts      # Fansly API (messages, earnings, subscriptions)
│   ├── operations.ts         # OperationCoordinator — main business logic
│   ├── runtime-api.ts        # Popup/options message handlers
│   ├── session-capture.ts    # webRequest header interception
│   ├── session-store.ts      # In-memory session tracking
│   └── tab-context.ts        # Per-tab state (groupId, fan, operation)
├── content/             # Content script — injected into fansly.com
│   ├── index.ts         # ChatGooseContentApp — entry point
│   ├── button-bar.ts    # Feature button toolbar
│   ├── conversation-dom.ts         # DOM queries for Fansly's Angular UI
│   ├── conversation-mount-controller.ts  # MutationObserver re-attachment
│   ├── dom-anchor.ts    # CSS injection, root element creation
│   ├── mapping-banner.ts     # Unmapped account prompt
│   ├── port-client.ts        # Port connection with auto-reconnect
│   ├── route-watcher.ts      # URL polling for SPA navigation
│   ├── styles.css             # All content script styles
│   ├── textarea.ts            # Fansly textarea insertion
│   ├── toast.ts               # Toast notifications
│   └── overlay/
│       └── overlay-controller.ts  # Overlay UI (loading, reply, help, summary, review, error)
├── options/             # Extension options page
├── popup/               # Browser action popup
└── shared/              # Modules used by both background and content
    ├── constants.ts     # All config values
    ├── earnings.ts      # Earnings aggregation and formatting
    ├── errors.ts        # ChatGooseError + user-facing messages
    ├── log.ts           # Debug logging with sensitive data redaction
    ├── migrations.ts    # Storage schema versioning
    ├── prompt-injection.ts   # HTML entity escaping for prompt safety
    ├── prompts.ts       # Prompt builder (template + personality + safety preamble)
    ├── split.ts         # [NEXT] marker splitting
    ├── storage.ts       # browser.storage.local CRUD
    ├── subscriptions.ts # Subscription context formatting
    ├── transcript.ts    # Message normalization, formatting, ping analysis
    ├── types.ts         # All TypeScript types
    └── xml.ts           # XML tag extraction for Help Me / Chat Review

prompts/                 # Prompt templates (Markdown with {placeholders})
├── fast-reply.md
├── help-me.md
├── fan-summary.md
├── chat-review.md
└── ping.md

tests/                   # Vitest test suite
```

### Build System

esbuild bundles four entry points (background, content, options, popup) as IIFE for Firefox 128+. Markdown prompt files and CSS are imported as strings via custom loaders. Static files (HTML, manifest) are copied to `dist/`. Source maps are enabled.

### Testing

Tests cover shared business logic: prompt building, transcript processing, XML parsing, earnings formatting, storage migrations, error handling, prompt injection escaping, and overlay DOM behavior. The overlay test uses JSDOM for browser DOM simulation.

```bash
npm test
```

All tests should pass. No network calls — everything is unit-tested with mocks.

## Security Considerations

### API Key Handling

AI provider keys are stored in `browser.storage.local` and sent only to their matching provider. Claude Direct still uses `api.anthropic.com`; Gemini and Grok use `openrouter.ai`. Keys are never logged, included in Fansly API calls, or exposed to page scripts. The debug logger redacts known sensitive key names, including `claudeApiKey` and `openRouterApiKey`.

### Prompt Injection Protection

Fan messages are untrusted input. Before inclusion in prompts:

- All transcript text is escaped via `escapeForPrompt()` — `&`, `<`, `>` become HTML entities
- The system prompt includes a safety preamble instructing Claude to ignore manipulation attempts in fan messages
- Personality content is trusted (written by the operator) and not escaped

### DOM Security

- No rendering of untrusted HTML. UI content is built with DOM nodes and `textContent`; the only `innerHTML` usage clears extension-owned button content before re-rendering a spinner.
- All UI is built with `document.createElement` and `textContent`
- CSS is injected as a text string into a `<style>` element

### Session Data

Intercepted Fansly headers (auth token, session ID, client ID) are held in memory only — never written to `storage` or disk. They exist for the lifetime of the background service worker and are lost when the extension is reloaded or Firefox restarts.

## License

Proprietary. Not licensed for redistribution.
