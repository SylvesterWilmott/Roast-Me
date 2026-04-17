# Roast Me

A Chrome extension for AI-powered UX testing. It navigates your site as a simulated persona and reports what it finds.

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

Output is written to `dist/`. A zipped copy of the extension is also written to `dist/roast-me-1.0.0.zip`.

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
