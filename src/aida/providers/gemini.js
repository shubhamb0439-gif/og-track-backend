const config = require('../../config');
const { toGeminiTools, executeTool } = require('../toolRegistry');

// Gemini's REST API is NOT OpenAI-compatible (unlike Groq/OpenRouter), so
// this is a real adapter, not a thin wrapper around openaiCompatible.js.
// Built against Google's documented contract for the "legacy" (but still
// live) generateContent/streamGenerateContent endpoints, fetched directly
// from ai.google.dev on 2026-09-24 since this postdates training knowledge
// — NOT hands-on tested against a real key (none was configured yet at
// build time). Sanity-check a real round-trip once GEMINI_API_KEY is set,
// the same way providers/openai.js's model list was verified live.
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const TIMEOUT_REPLY =
  "I gathered some data but couldn't finish putting together an answer in time — could you narrow down the question?";

function historyToContents(history) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function callGemini(model, body, signal) {
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-API-Key': config.aida.geminiApiKey },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  return data;
}

async function runTools(functionCalls, context, toolCallLog) {
  return Promise.all(
    functionCalls.map(async (p) => {
      const { name, id, args } = p.functionCall;
      const result = await executeTool(name, args || {}, context);
      toolCallLog.push({ tool: name, input: args, error: result && result.error ? result.error : null });
      return { name, id, result };
    })
  );
}

function toolResultsToContent(results) {
  return {
    role: 'user',
    parts: results.map(({ name, id, result }) => ({
      functionResponse: { name, ...(id ? { id } : {}), response: { result } },
    })),
  };
}

async function runTurn({ system, history, userMessage, context, model, signal }) {
  const tools = toGeminiTools(context);
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: userMessage }] }];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const data = await callGemini(model, { system_instruction: { parts: [{ text: system }] }, contents, tools }, signal);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (!functionCalls.length) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
      return { reply: text || "I don't have a response for that.", toolCalls: toolCallLog };
    }

    contents.push({ role: 'model', parts });
    const results = await runTools(functionCalls, context, toolCallLog);
    contents.push(toolResultsToContent(results));
  }

  return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
}

/**
 * Streaming counterpart — same tool-use loop over Gemini's SSE stream
 * ("data: <json>\n\n" frames). Unlike OpenAI's token-by-token function-call
 * argument accumulation, Gemini's documented behavior sends each part
 * (text or a complete functionCall) as a whole unit per chunk, so there's no
 * partial-JSON accumulator needed here — see providers/openai.js for the
 * contrasting case where one is required.
 */
async function runTurnStream({ system, history, userMessage, context, model, onDelta, onFirstToken, signal }) {
  const tools = toGeminiTools(context);
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: userMessage }] }];
  const toolCallLog = [];

  for (let iteration = 0; iteration < config.aida.maxToolIterations; iteration++) {
    const res = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-API-Key': config.aida.geminiApiKey },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, tools }),
      signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.error?.message || `Gemini API error (${res.status})`);
    }

    let fullText = '';
    const allParts = [];
    let firstTokenSeen = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;
          const chunk = JSON.parse(jsonStr);
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              fullText += part.text;
              if (!firstTokenSeen) { firstTokenSeen = true; onFirstToken?.(); }
              onDelta?.(part.text);
              allParts.push(part);
            } else if (part.functionCall) {
              allParts.push(part);
            }
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (fullText) return { reply: fullText.trim(), toolCalls: toolCallLog, degraded: true };
      throw e;
    }

    if (signal && signal.aborted) {
      return { reply: fullText.trim(), toolCalls: toolCallLog, interrupted: true };
    }

    const functionCalls = allParts.filter((p) => p.functionCall);
    if (!functionCalls.length) {
      return { reply: fullText.trim() || "I don't have a response for that.", toolCalls: toolCallLog };
    }

    contents.push({ role: 'model', parts: allParts });
    const results = await runTools(functionCalls, context, toolCallLog);
    contents.push(toolResultsToContent(results));
  }

  return { reply: TIMEOUT_REPLY, toolCalls: toolCallLog };
}

module.exports = { runTurn, runTurnStream };
