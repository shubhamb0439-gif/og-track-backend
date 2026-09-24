const OpenAI = require('openai');
const config = require('../../config');
const { toOpenAITools, executeTool } = require('../toolRegistry');

const TIMEOUT_REPLY =
  "I gathered some data but couldn't finish putting together an answer in time — could you narrow down the question?";

/**
 * Shared implementation behind every provider whose API is OpenAI-compatible
 * (OpenAI itself, Groq, OpenRouter) — same Chat Completions request/response
 * shape, same tool-calling contract, only the base URL, API key, and
 * optional extra headers differ. Extracted once three real instances of this
 * existed (see providers/openai.js, groq.js, openrouter.js) rather than
 * copy-pasting the whole tool-use loop three times.
 *
 * getApiKey/getBaseURL are functions (not values) so the caller always reads
 * the current config at call time — matches the rest of this codebase's
 * lazy-client pattern (see the original providers/openai.js) rather than
 * capturing a possibly-not-yet-loaded key at require() time.
 */
function createOpenAICompatibleProvider({ getApiKey, getBaseURL, defaultHeaders }) {
  let client = null;
  function getClient() {
    if (!client) {
      client = new OpenAI({
        apiKey: getApiKey(),
        baseURL: getBaseURL ? getBaseURL() : undefined,
        defaultHeaders,
      });
    }
    return client;
  }

  async function runTurn({ system, history, userMessage, context, model }) {
    const tools = toOpenAITools(context);
    const messages = [
      { role: 'system', content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];
    const toolCallLog = [];

    for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
      const response = await getClient().chat.completions.create({
        model,
        messages,
        tools: tools.length ? tools : undefined,
      });

      const message = response.choices[0].message;

      if (!message.tool_calls || !message.tool_calls.length) {
        const text = (message.content || '').trim();
        return { reply: text || "I don't have a response for that.", toolCalls: toolCallLog };
      }

      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });

      const results = await Promise.all(
        message.tool_calls.map(async (call) => {
          let args = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            args = {};
          }
          const result = await executeTool(call.function.name, args, context);
          toolCallLog.push({ tool: call.function.name, input: args, error: result && result.error ? result.error : null });
          return { call, result };
        })
      );

      for (const { call, result } of results) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
  }

  async function runTurnStream({ system, history, userMessage, context, model, onDelta, onFirstToken, signal }) {
    const tools = toOpenAITools(context);
    const messages = [
      { role: 'system', content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];
    const toolCallLog = [];

    for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
      const stream = await getClient().chat.completions.create(
        { model, messages, tools: tools.length ? tools : undefined, stream: true },
        { signal }
      );

      let fullContent = '';
      const toolCallAcc = new Map(); // index -> { id, name, arguments }
      let finishReason = null;
      let firstTokenSeen = false;

      try {
        for await (const part of stream) {
          const choice = part.choices && part.choices[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (delta.content) {
            fullContent += delta.content;
            if (!firstTokenSeen) { firstTokenSeen = true; onFirstToken?.(); }
            onDelta?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const acc = toolCallAcc.get(tc.index) || { id: tc.id, name: '', arguments: '' };
              if (tc.id) acc.id = tc.id;
              if (tc.function && tc.function.name) acc.name += tc.function.name;
              if (tc.function && tc.function.arguments) acc.arguments += tc.function.arguments;
              toolCallAcc.set(tc.index, acc);
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (fullContent) return { reply: fullContent.trim(), toolCalls: toolCallLog, degraded: true };
        throw e;
      }

      if (signal && signal.aborted) {
        return { reply: fullContent.trim(), toolCalls: toolCallLog, interrupted: true };
      }

      if (finishReason !== 'tool_calls' || toolCallAcc.size === 0) {
        const text = fullContent.trim();
        return { reply: text || "I don't have a response for that.", toolCalls: toolCallLog };
      }

      const orderedToolCalls = [...toolCallAcc.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
      messages.push({
        role: 'assistant',
        content: fullContent || null,
        tool_calls: orderedToolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
      });

      const results = await Promise.all(
        orderedToolCalls.map(async (tc) => {
          let args = {};
          try {
            args = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            args = {};
          }
          const result = await executeTool(tc.name, args, context);
          toolCallLog.push({ tool: tc.name, input: args, error: result && result.error ? result.error : null });
          return { tc, result };
        })
      );

      for (const { tc, result } of results) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }

    return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
  }

  return { runTurn, runTurnStream };
}

module.exports = { createOpenAICompatibleProvider };
