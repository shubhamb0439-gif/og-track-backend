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

module.exports = { runTurn };
