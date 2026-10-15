import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// Credentials are read when requests run; builds do not need production secrets.
const openrouter = createOpenAICompatible({
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || '',
  supportsStructuredOutputs: true,
});
export const reviewModel = openrouter(process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5');
