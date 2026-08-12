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

module.exports = { runTurn };
