import { defineAgent } from 'eve';
import { reviewModel } from '../src/model.js';

export default defineAgent({
  model: reviewModel,
  defaultTools: false,
  tool: false,
  modelContextWindowTokens: 64_000,
});
