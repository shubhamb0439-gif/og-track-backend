const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { toAnthropicTools, executeTool } = require('../toolRegistry');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.aida.apiKey });
  return client;
}

const TIMEOUT_REPLY =
  "I gathered some data but couldn't finish putting together an answer in time — could you narrow down the question?";

/**
 * Anthropic's tool-use loop: keep calling the model, executing whatever
 * tools it asks for, and feeding results back as tool_result blocks, until
 * it returns plain text (stop_reason !== 'tool_use') or we hit the
 * iteration cap. Multiple tool_use blocks in one response are executed
 * concurrently — that's what lets a single turn cover several modules.
 */
async function runTurn({ system, history, userMessage, context }) {
  const tools = toAnthropicTools(context);
  const messages = [...history, { role: 'user', content: userMessage }];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const response = await getClient().messages.create({
      model: config.aida.model,
      max_tokens: 1536,
      system,
      messages,
      tools: tools.length ? tools : undefined,
    });

    if (response.stop_reason !== 'tool_use') {
      const text = (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text || "I don't have a response for that.", toolCalls: toolCallLog };
    }

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    const results = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input, context);
        toolCallLog.push({ tool: block.name, input: block.input, error: result && result.error ? result.error : null });
        return { block, result };
      })
    );

    messages.push({
      role: 'user',
      content: results.map(({ block, result }) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })),
    });
  }

  return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
}

function safeParseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

/**
 * Streaming counterpart of runTurn — same tool-use loop over raw Anthropic
 * stream events (content_block_start/delta, message_delta for stop_reason),
 * text deltas forwarded via onDelta as they arrive. See providers/openai.js
 * for the shared error-handling rationale (AbortError always propagates;
 * a failure after some text already streamed degrades gracefully with what
 * was generated; a failure before any text propagates so engine.js can fall
 * back to the non-streaming runTurn() with nothing lost).
 */
async function runTurnStream({ system, history, userMessage, context, onDelta, onFirstToken, signal }) {
  const tools = toAnthropicTools(context);
  const messages = [...history, { role: 'user', content: userMessage }];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const stream = await getClient().messages.create(
      { model: config.aida.model, max_tokens: 1536, system, messages, tools: tools.length ? tools : undefined, stream: true },
      { signal }
    );

    const blocks = []; // index -> { type: 'text', text } | { type: 'tool_use', id, name, inputJson }
    let stopReason = null;
    let firstTokenSeen = false;

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          blocks[event.index] = event.content_block.type === 'tool_use'
            ? { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, inputJson: '' }
            : { type: 'text', text: '' };
        } else if (event.type === 'content_block_delta') {
          const block = blocks[event.index];
          if (!block) continue;
          if (event.delta.type === 'text_delta') {
            block.text += event.delta.text;
            if (!firstTokenSeen) { firstTokenSeen = true; onFirstToken?.(); }
            onDelta?.(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            block.inputJson += event.delta.partial_json;
          }
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) return { reply: text, toolCalls: toolCallLog, degraded: true };
      throw e;
    }

    // See providers/openai.js's identical check — some SDK/transport
    // combinations end an aborted stream's iteration early rather than
    // throwing, so check the signal directly rather than relying on a catch.
    if (signal && signal.aborted) {
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text, toolCalls: toolCallLog, interrupted: true };
    }

    if (stopReason !== 'tool_use') {
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text || "I don't have a response for that.", toolCalls: toolCallLog };
    }

    const toolUseBlocks = blocks
      .map((b, id) => ({ b, id }))
      .filter(({ b }) => b && b.type === 'tool_use')
      .map(({ b }) => ({ id: b.id, name: b.name, input: safeParseJson(b.inputJson) }));

    messages.push({
      role: 'assistant',
      content: blocks.filter(Boolean).map((b) =>
        b.type === 'tool_use'
          ? { type: 'tool_use', id: b.id, name: b.name, input: safeParseJson(b.inputJson) }
          : { type: 'text', text: b.text }
      ),
    });

    const results = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input, context);
        toolCallLog.push({ tool: block.name, input: block.input, error: result && result.error ? result.error : null });
        return { block, result };
      })
    );

    messages.push({
      role: 'user',
      content: results.map(({ block, result }) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })),
    });
  }

  return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
}

module.exports = { runTurn, runTurnStream };
