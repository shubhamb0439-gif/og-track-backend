const OpenAI = require('openai');
const config = require('../../config');
const { toOpenAITools, executeTool } = require('../toolRegistry');

let client = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.aida.apiKey });
  return client;
}

const TIMEOUT_REPLY =
  "I gathered some data but couldn't finish putting together an answer in time — could you narrow down the question?";

/**
 * Same shape of loop as providers/anthropic.js, adapted to OpenAI's Chat
 * Completions message format: the system prompt is its own message, tool
 * calls arrive as `message.tool_calls` (JSON-string arguments), and results
 * go back as separate role:'tool' messages keyed by tool_call_id — there's
 * no single "tool_result block" concept like Anthropic's.
 */
async function runTurn({ system, history, userMessage, context }) {
  const tools = toOpenAITools(context);
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const response = await getClient().chat.completions.create({
      model: config.aida.model,
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

/**
 * Streaming counterpart of runTurn — identical tool-use loop, but the
 * content-generating call streams its text out via onDelta as it arrives
 * instead of only resolving once complete. Tool-calling iterations don't
 * carry user-facing content (OpenAI returns empty content while it's
 * requesting tool calls), so only the FINAL iteration ever has anything to
 * stream — which is also the only iteration whose latency the user actually
 * feels, since tool calls execute sequentially before it.
 *
 * Error handling: an AbortError (user interruption, see voiceSession.js's
 * shared per-turn AbortController) always propagates up as-is. Any other
 * failure DURING an iteration that had already streamed some content
 * degrades gracefully (returns what was generated rather than throwing,
 * since audio may already be mid-flight for it) — a failure BEFORE any
 * content was ever produced instead propagates, so engine.js can fall back
 * to the plain non-streaming runTurn() with nothing to unwind.
 */
async function runTurnStream({ system, history, userMessage, context, onDelta, onFirstToken, signal }) {
  const tools = toOpenAITools(context);
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const stream = await getClient().chat.completions.create(
      { model: config.aida.model, messages, tools: tools.length ? tools : undefined, stream: true },
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

    // A barge-in abort doesn't always surface as a thrown AbortError — some
    // SDK versions/transports just end the stream's iteration early instead
    // (confirmed live: the loop above exits normally with truncated content
    // rather than throwing). Check the signal directly so an interruption is
    // still reported as one instead of looking like a short, complete reply.
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

module.exports = { runTurn, runTurnStream };
