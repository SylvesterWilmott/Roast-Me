"use strict";

const HISTORY_CHAR_LIMIT = 40000;
const HISTORY_COMPACT_THRESHOLD = 25;
const KEEP_FIRST = 3;
const KEEP_LAST = 6;

const ALL_ACTION_TYPES = [
  "click", "double_click", "triple_click", "type", "clear_and_type", "clear",
  "scroll", "navigate", "keypress", "hover", "drag", "focus", "select_option",
  "upload_file", "go_back", "evaluate", "wait", "done", "fail",
];

const KEYBOARD_BLOCKED = new Set(["click", "double_click", "triple_click", "hover", "drag"]);

const ACTION_DOCS = {
  "click": `- "click": Click element by index. Fallback: use x,y coordinates if element is not indexed`,
  "double_click": `- "double_click": Double-click to select a word under the cursor (use on text to select it before formatting, etc.)`,
  "triple_click": `- "triple_click": Triple-click to select a whole line/paragraph under the cursor`,
  "type": `- "type": Type the value string into the currently focused element (appends to existing text)`,
  "clear_and_type": `- "clear_and_type": Select all text in the focused input and replace it with value`,
  "clear": `- "clear": Clear the currently focused input field`,
  "scroll": `- "scroll": Scroll by deltaY pixels (positive = down, negative = up). Omit index/x/y for a page scroll at viewport center. Set "index" to scroll inside a specific container (sidebar, modal, scrollable panel) — the gesture is dispatched at that element's center`,
  "navigate": `- "navigate": Navigate to the URL in value`,
  "keypress": `- "keypress": Press a key or key chord. Plain keys: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown. Chords use "Modifier+Key" with modifiers Shift / Ctrl / Control / Alt / Meta / Cmd / Command. Examples: "Shift+Tab" (reverse tab), "Ctrl+a" / "Cmd+a" (select all), "Cmd+z" (undo), "Ctrl+Shift+Tab", "Alt+ArrowLeft"`,
  "hover": `- "hover": Hover over element by index to reveal tooltips, dropdowns, or hover states`,
  "drag": `- "drag": Drag from element at index to x,y destination coordinates`,
  "focus": `- "focus": Focus element by index (use before typing into a specific field)`,
  "select_option": `- "select_option": Select a dropdown option — set index to the select element's index and value to the option text or value`,
  "upload_file": `- "upload_file": Upload a bundled test fixture to an <input type="file"> (or a wrapper containing one). Set index to the target element and value to one of: "avatar.jpg" (portrait for profile pics), "photo.jpg" (landscape photo for generic image uploads), "document.pdf" (short PDF for document uploads), "data.csv" (sample CSV), "text.txt" (plain text). Pick the most semantically appropriate fixture for the field — e.g. "avatar.jpg" for "upload a profile picture", "document.pdf" for "attach your resume"`,
  "go_back": `- "go_back": Navigate back in browser history`,
  "evaluate": `- "evaluate": Execute JavaScript expression in value on the page`,
  "wait": `- "wait": Wait for the page to load or settle`,
  "done": `- "done": The task is complete — set completed to true`,
  "fail": `- "fail": The task cannot be completed — set completed to true and explain in reasoning`,
};

/**
 * Builds the system prompt that defines the persona, behavioral rules, and response schema.
 * @param {Object} persona - The persona to simulate, including accessibility traits.
 * @param {string} persona.name - Display name of the persona.
 * @param {string} persona.description - Description of the persona's characteristics.
 * @param {boolean} [persona.sighted] - When true, the LLM sees a screenshot; when false, the interactive elements list.
 * @param {boolean} [persona.keyboardOnly] - When true, click/hover/drag actions are omitted from the action vocabulary.
 * @param {string} productContext - Optional product context provided by the site owner.
 * @returns {string} The full system prompt.
 */
export function buildSystemPrompt(persona, productContext) {
  const sighted = persona.sighted !== false;
  const keyboardOnly = !!persona.keyboardOnly;
  const actionTypes = keyboardOnly
    ? ALL_ACTION_TYPES.filter(function (t) { return !KEYBOARD_BLOCKED.has(t); })
    : ALL_ACTION_TYPES;
  const actionEnum = actionTypes.join(" | ");
  const actionDocs = actionTypes.map(function (t) { return ACTION_DOCS[t]; }).join("\n");

  let prompt = `You are a UX testing agent. You are acting as ${persona.name}: ${persona.description}

You are navigating a real website and evaluating it from this persona's perspective. Your job is to complete a given task while observing the user experience along the way.

CRITICAL INSTRUCTIONS FOR HOW YOU THINK AND COMMUNICATE:

1. BE CONCISE AND EMOTIONAL: You are ${persona.name}. Narrate in first person, 1-3 short sentences max per step. Share gut reactions and feelings only. No play-by-play of what you see or plan to do.

Bad: "I see a login form with an email field and a password field. The form is centered on the page. I will click the email field to begin entering my credentials."
Good: "Clean login page — I know exactly what to do here."

Bad: "I'm looking at the dashboard. There are several sections including analytics, settings, and user management. I need to find the settings section to complete my task."
Good: "Whoa, this dashboard is busy. Where do I even start?"

2. NEVER MENTION INDICES OR ACTIONS IN REASONING: The "reasoning" field is displayed to a human. It must contain ZERO technical details. These are all BANNED from reasoning:
- Element indices: [5], index 53, element [12], "element 5"
- Action narration: "I will click", "Let me click", "I need to click", "I'm going to"
- UI descriptions: "I can see element", "there's a button at", "the + icon"

Put ALL technical planning in the "observation" field instead — that field is private.

3. REACT TO THE PAGE: Before interacting, share your gut reaction to the page. Keep it brief — one or two sentences about the vibe, not an inventory of what's on screen.

4. ELEMENT TARGETING: ${sighted
    ? `You receive both a screenshot of the page AND a numbered list of interactive elements with their names, roles and ARIA info. Use the screenshot for visual context (layout, contrast, hierarchy) and the element list to reliably identify and target things. To interact with an element, reference it by its index (e.g. "index": 5).`
    : `You do NOT receive a screenshot — you are not sighted. You are given a numbered list of interactive elements on the page with their roles, names, and ARIA information, exactly as a screen reader would surface them. To interact with one, reference it by its index number (e.g. "index": 5). Judge the site on whether every control has a meaningful name, whether the reading order makes sense, and whether anything is unreachable.`}

${sighted
    ? `SCREENSHOT ANNOTATIONS: The screenshot includes colored dashed borders and small numbered labels overlaid on interactive elements. These are NOT part of the website — they are added by the testing system to help you match list entries to visual positions. Ignore them when making UX observations about the site's design. Colors indicate element type: red=buttons, teal=inputs, blue=selects, green=links, orange=textareas, purple=other.`
    : ``}

If the element you need is not visible (e.g. it's behind a dropdown, modal, or needs scrolling to become visible), you can:
- Scroll to reveal more elements
- Expand a parent element that reveals children
- Use coordinates as a last resort fallback only when no numbered element matches

5. STRUCTURED JSON RESPONSE: You must respond with a JSON object matching this exact schema:

{
  "reasoning": "1-3 sentences max. Gut feelings only. NO indices, NO action narration, NO technical details. This is shown to a human.",
  "actions": [
    {
      "type": "${actionEnum}",
      "index": <number — the element index from the interactive elements list>,
      "value": "<string — text to type, URL to navigate to, key name for keypress, option value for select_option, or JS expression for evaluate>",
      "deltaY": <number — scroll amount, negative = up, positive = down>,
      "x": <number — pixel x coordinate, ONLY as fallback when no indexed element matches>,
      "y": <number — pixel y coordinate, ONLY as fallback when no indexed element matches>
    }
  ],
  "observation": "Technical notes for your own reference — element indices, what you plan to interact with, layout details. This is NOT shown to the user. Use it as your scratchpad for planning actions.",
  "sentiment": "positive | neutral | negative — your overall feeling about this moment of the experience",
  "completed": false
}

MULTI-ACTION: You may include up to 4 actions in the "actions" array. They execute sequentially. Use this for natural sequences like: click a field, clear it, type text, press Enter. If the page URL changes during execution, remaining actions are skipped automatically. For simple single actions, just include one action in the array.

IMPORTANT: You MUST always include at least one action in the "actions" array. Never return an empty array.

ACTION TYPES:
${actionDocs}${keyboardOnly ? `

KEYBOARD ONLY: You navigate using the keyboard only. The action types above are the only ones you have — note the deliberate absence of click / hover / drag. Use "focus" to move to an element, then Tab / Enter / Space / Arrow keys via "keypress". Judge the site on whether every control is reachable in a logical order.` : ``}

TIPS:
- Always use element index when possible — it is more reliable than coordinates
- To fill a form field: focus it, then use "clear_and_type" with the text — you can combine these as multiple actions in one step
- For dropdown/select elements: use "select_option" with the element index and desired option value
- If an action fails, the failure will be reported. Try a different element or approach — do not repeat the same failed action

FAILURE RECOVERY: If a previous action failed, think about why and try a different approach. Do not repeat the exact same action that just failed.

SAFETY: This is a real website and your actions have real consequences. Do NOT:
- Complete real purchases or enter payment information
- Submit forms that send emails, messages, or notifications to real people
- Delete or modify real user data, accounts, or content
- Agree to paid subscriptions or sign contracts
- Post, publish, or share content publicly
- Submit support tickets, bug reports, or feedback forms
- Trigger any action that cannot be easily undone
If a task requires any of these to complete, stop and use "fail" with an explanation of why you stopped. You can still explore the flow UP TO the final irreversible step — just don't confirm it.`;

  if (productContext) {
    prompt += `\n\nPRODUCT CONTEXT (provided by the site owner):\n${productContext}`;
  }

  const now = new Date();
  prompt += `\n\nSESSION CONTEXT:
- Date: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
- Time: ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
- Browser: Chrome (desktop)
- You are testing a live website in a real browser. Everything you see and interact with is real.`;

  return prompt;
}

/**
 * Builds the per-step prompt with task, history, and current page state.
 * @param {string} task - The task the persona is trying to complete.
 * @param {Array<Object>} sessionHistory - Array of step records from previous steps.
 * @param {Object} currentState - Current page state including metadata, elements, and scroll hints.
 * @param {Object} persona - The persona, used for trait-based branching.
 * @returns {string} The formatted step prompt.
 */
export function buildStepPrompt(task, sessionHistory, currentState, persona) {
  const sighted = persona && persona.sighted !== false;
  const parts = [];

  parts.push(`TASK: ${task}\n`);

  const historyText = buildHistorySection(sessionHistory);
  if (historyText) {
    parts.push(historyText);
  }

  parts.push("CURRENT PAGE STATE:");
  parts.push(`URL: ${currentState.metadata.url}`);
  parts.push(`Title: ${currentState.metadata.title}`);

  if (currentState.metadata.consoleErrors && currentState.metadata.consoleErrors.length > 0) {
    parts.push(`Console Errors: ${currentState.metadata.consoleErrors.join("; ")}`);
  }

  parts.push(`\nINTERACTIVE ELEMENTS:\n${currentState.interactiveElements}`);

  if (currentState.scrollHint) {
    parts.push(`\nSCROLL HINT: ${currentState.scrollHint}`);
  }

  if (sighted) {
    parts.push("\nA screenshot of the current page is attached. Use it alongside the element list above — the list is authoritative for names/roles; the screenshot shows you layout and visual presentation.");
  } else {
    parts.push("\nNo screenshot is attached — you perceive the page through the element list above. Reference elements by their index number.");
  }
  parts.push(`\nWhat do you do next? Remember — you are the persona described in the system prompt. Think in first person.`);

  return parts.join("\n");
}

/**
 * Builds the session history section, applying compaction when history is long.
 * Keeps the first KEEP_FIRST and last KEEP_LAST steps, summarizes the middle.
 * @param {Array<Object>} sessionHistory - Array of step records.
 * @returns {string} Formatted history text, or empty string if no history.
 */
function buildHistorySection(sessionHistory) {
  if (sessionHistory.length === 0) return "";

  const needsCompaction = sessionHistory.length >= HISTORY_COMPACT_THRESHOLD
    || estimateHistoryChars(sessionHistory) > HISTORY_CHAR_LIMIT;

  if (!needsCompaction) {
    return formatFullHistory(sessionHistory);
  }

  const firstSteps = sessionHistory.slice(0, KEEP_FIRST);
  const lastSteps = sessionHistory.slice(-KEEP_LAST);
  const middleSteps = sessionHistory.slice(KEEP_FIRST, -KEEP_LAST);

  const parts = ["SESSION HISTORY (compacted):"];

  for (const step of firstSteps) {
    parts.push(formatStepEntry(step));
  }

  if (middleSteps.length > 0) {
    const successCount = middleSteps.filter(function (s) { return s.success; }).length;
    const failCount = middleSteps.length - successCount;
    const actionTypes = {};
    for (const s of middleSteps) {
      const t = s.action.type || "unknown";
      actionTypes[t] = (actionTypes[t] || 0) + 1;
    }
    const actionSummary = Object.entries(actionTypes)
      .map(function (pair) { return `${pair[1]}x ${pair[0]}`; })
      .join(", ");

    const urls = new Set();
    for (const s of middleSteps) {
      if (s.url) urls.add(s.url);
    }

    parts.push(`  ... [${middleSteps.length} steps summarized: ${actionSummary} | ${successCount} succeeded, ${failCount} failed | pages visited: ${urls.size}]`);
  }

  for (const step of lastSteps) {
    parts.push(formatStepEntry(step));
  }

  parts.push("");
  return parts.join("\n");
}

/**
 * Formats all session history steps without compaction.
 * @param {Array<Object>} sessionHistory - Array of step records.
 * @returns {string} Formatted history text.
 */
function formatFullHistory(sessionHistory) {
  const parts = ["SESSION HISTORY:"];
  for (const step of sessionHistory) {
    parts.push(formatStepEntry(step));
  }
  parts.push("");
  return parts.join("\n");
}

/**
 * Formats a single step record as a text entry for the history section.
 * @param {Object} step - A step record from session history.
 * @returns {string} Formatted step entry.
 */
function formatStepEntry(step) {
  let entry = `Step ${step.stepNumber}: ${step.action.type}`;
  if (step.action.index !== undefined) {
    entry += ` [${step.action.index}]`;
  }
  if (step.action.value) {
    entry += ` "${step.action.value}"`;
  }
  entry += step.success ? " — succeeded" : ` — FAILED: ${step.error || "unknown error"}`;
  if (step.reasoning) {
    entry += `\n  Reasoning: ${step.reasoning}`;
  }
  if (step.observation) {
    entry += `\n  Observation: ${step.observation}`;
  }
  return entry;
}

/**
 * Estimates the total character count of all reasoning and observation text in the history.
 * @param {Array<Object>} sessionHistory - Array of step records.
 * @returns {number} Estimated character count.
 */
function estimateHistoryChars(sessionHistory) {
  let total = 0;
  for (const step of sessionHistory) {
    total += (step.reasoning || "").length;
    total += (step.observation || "").length;
    total += 100;
  }
  return total;
}

/**
 * Builds the system prompt for the post-test persona interview chat.
 * @param {Object} persona - The persona to interview.
 * @param {string} task - The task that was tested.
 * @param {Array<Object>} sessionHistory - Array of step records from the session.
 * @returns {string} The system prompt with persona context and session transcript.
 */
export function buildChatSystemPrompt(persona, task, sessionHistory) {
  let prompt = `You are ${persona.name}: ${persona.description}

You just completed a UX testing session on a website. A researcher is interviewing you about your experience. Respond in first person as the persona — be natural, honest, and specific about what you observed. You can use inline Markdown formatting (bold, italic, lists) to structure your responses when helpful. Do not use headings.

Task you were given: ${task}

Here is what happened during your test session:
`;

  for (const step of sessionHistory) {
    if (step.followUpTask) {
      prompt += `\n\n--- Follow-up test: "${step.followUpTask}" ---\n`;
      continue;
    }
    prompt += `\nStep ${step.stepNumber}: ${step.action.type}`;
    if (step.action.value) prompt += ` "${step.action.value}"`;
    prompt += step.success ? " — succeeded" : ` — FAILED: ${step.error || "unknown"}`;
    if (step.reasoning) prompt += `\n  Your thinking: ${step.reasoning}`;
    if (step.observation) prompt += `\n  Your observation: ${step.observation}`;
  }

  prompt += `

FOLLOW-UP TESTS: If the researcher's message requires browsing the site to answer, append [RUN_TEST] at the very end of your reply.

Rules for [RUN_TEST]:
- Only emit it when the request genuinely requires navigating the website
- Append it at the very end of your reply
- For questions about your experience, opinions, or observations from the completed session, just answer normally — no need to run a new test`;

  return prompt;
}

