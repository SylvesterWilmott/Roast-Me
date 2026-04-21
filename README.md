# Roast Me

A Chrome extension for AI-powered UX testing. It navigates your site as a simulated persona and reports what it finds.

## Features

- **Persona-driven testing** — run your site through five built-in personas (First-time Visitor, Power User, Accessibility-focused, Non-technical User, Roaster) or create your own.
- **Structured persona traits** — age band, tech literacy, sighted / not sighted, color-blindness type, and keyboard-only navigation. Rendered as explicit constraints in the system prompt so personas stay consistent across runs.
- **Color-blindness vision filter** — the page is rendered through a matching SVG color matrix during the run so the agent observes what the persona actually sees (protanopia, deuteranopia, tritanopia, achromatopsia).
- **Rich agent vocabulary** — click / double-click / triple-click, hover, drag, scroll (page or inside a container), type / clear-and-type, select-option, focus, keypress with modifier chords, file upload via bundled fixtures, go-back, wait.
- **Step-by-step narration** — each step shows the persona's in-character reasoning, the current screenshot with the gesture composited on top (click ring, scroll sweep, drag line), and a status chip for any failures.
- **Post-test interview** — chat with the persona after the session to ask follow-up questions; responses stream with markdown rendering.
- **Follow-up tests from chat** — the persona can launch a second test run on its own when a question needs more browsing to answer.
- **Origin lock** — cross-origin top-frame navigations are cancelled at the network layer. Tests stay on the site you started on, with a clear blocked step logged when the agent tries to stray.
- **Stuck detection** — a rolling action-loop detector nudges the agent to stop and ask the researcher a specific guidance question after a few repeated attempts instead of spinning.
- **Safety rails** — the agent is barred from completing purchases, submitting real messages, publishing content, deleting data, or confirming any irreversible step.
- **Prompt-injection defense** — all page content is framed as untrusted data, not instructions.
- **Task history** — up / down arrows on the initial screen cycle through recent tasks (persisted across browser sessions).
- **Session export** — download a `.zip` containing a self-contained `report.html` (images inlined, styled exactly like the side panel) and a structured `session.json` (persona config, per-step actions / reasoning / outcomes, chat transcript) — shareable with stakeholders who don't have the extension installed.
- **Model picker** — switch between Claude Sonnet 4.6, Opus 4.6, and Haiku 4.5 per run.
- **Side panel UI** — task input, persona picker, live step feed, and post-test chat all in one compact panel with light/dark theme support.

## Requirements

- Chrome 116 or later
- Node.js and npm
- A Claude API key from the [Anthropic Console](https://console.anthropic.com/settings/keys)

## Build

Install dependencies and produce a production build:

```
npm install
npm run build
```

Output is written to `dist/`. A zipped copy of the extension is also written to `dist/roast-me-1.1.0.zip`.

For development, run a watcher that rebuilds on change:

```
npm run watch
```

## Install in Chrome

1. Download the latest `roast-me-*.zip` from the [Releases](../../releases) page and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin the extension, then click its icon to open the side panel.
6. Paste your Claude API key when prompted.

To install from source instead, run `npm run build` and load the generated `dist/` directory the same way. After code changes, rebuild and click the reload icon on the extension's card in `chrome://extensions`.
