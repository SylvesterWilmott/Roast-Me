"use strict";

const API_BASE = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const API_VERSION = "2023-06-01";

/**
 * Client for the Claude Messages API.
 */
export default class ClaudeClient {
  /**
   * @param {string} apiKey - Anthropic API key.
   * @param {string} [model] - Model identifier to use for requests.
   */
  constructor(apiKey, model = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Sends a message expecting a structured JSON response conforming to the agent action schema.
   * @param {string} systemPrompt - The system prompt.
   * @param {Array<Object>} userContent - Array of content blocks (text and image) for the user turn.
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the request.
   * @returns {Promise<string>} The response text.
   */
  async sendMessage(systemPrompt, userContent, signal) {
    const body = {
      model: this.model,
      max_tokens: 2048,
      temperature: 0.2,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              reasoning: { type: "string" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    index: { type: "integer" },
                    value: { type: "string" },
                    deltaY: { type: "number" },
                    x: { type: "number" },
                    y: { type: "number" },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
              },
              observation: { type: "string" },
              sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
              completed: { type: "boolean" },
            },
            required: ["reasoning", "actions", "observation", "sentiment", "completed"],
            additionalProperties: false,
          },
        },
      },
    };

    return this._request(body, signal);
  }

  /**
   * Sends a multi-turn conversation for the post-test interview chat.
   * @param {string} systemPrompt - The system prompt with persona and session context.
   * @param {Array<Object>} messages - Array of {role, content} message objects.
   * @returns {Promise<string>} The assistant's reply text.
   */
  async sendChat(systemPrompt, messages) {
    const body = {
      model: this.model,
      max_tokens: 2048,
      temperature: 0.5,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: messages,
    };

    return this._request(body);
  }

  /**
   * Streams a multi-turn conversation, calling onChunk with each text delta.
   * @param {string} systemPrompt - The system prompt.
   * @param {Array<Object>} messages - Array of {role, content} message objects.
   * @param {Function} onChunk - Called with each text delta string as it arrives.
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the stream.
   * @returns {Promise<string>} The complete accumulated response text.
   */
  async streamChat(systemPrompt, messages, onChunk, signal) {
    const body = {
      model: this.model,
      max_tokens: 8192,
      temperature: 0.5,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: messages,
      stream: true,
    };

    const response = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 429) {
        throw new Error(chrome.i18n.getMessage("RATE_LIMIT_ERROR"));
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(chrome.i18n.getMessage("INVALID_API_KEY_ERROR"));
      }
      throw new Error(chrome.i18n.getMessage("API_ERROR", [String(response.status), errorBody]));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          if (event.type === "content_block_delta" && event.delta?.text) {
            accumulated += event.delta.text;
            onChunk(event.delta.text);
          }
        } catch (err) {
          // Skip unparseable lines
        }
      }
    }

    return accumulated;
  }

  /**
   * Sends a request to the Claude API and extracts the text response.
   * @param {Object} body - The full request body.
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the request.
   * @returns {Promise<string>} The text content from the first text block.
   * @throws {Error} On HTTP errors, empty responses, or missing text content.
   */
  async _request(body, signal) {
    const response = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[Claude] API error", response.status, errorBody);
      if (response.status === 429) {
        throw new Error(chrome.i18n.getMessage("RATE_LIMIT_ERROR"));
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(chrome.i18n.getMessage("INVALID_API_KEY_ERROR"));
      }
      throw new Error(chrome.i18n.getMessage("API_ERROR", [String(response.status), errorBody]));
    }

    const data = await response.json();

    if (data.type === "error") {
      throw new Error(chrome.i18n.getMessage("CLAUDE_ERROR", [data.error?.message || "Unknown error"]));
    }

    if (!data.content || data.content.length === 0) {
      throw new Error(chrome.i18n.getMessage("EMPTY_RESPONSE_ERROR"));
    }

    const textBlock = data.content.find(function (block) { return block.type === "text"; });
    if (!textBlock || !textBlock.text) {
      throw new Error(chrome.i18n.getMessage("NO_TEXT_CONTENT_ERROR"));
    }

    return textBlock.text;
  }
}
