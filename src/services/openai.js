import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import { prompt as entryPrompt } from '../prompts/entry-summary-v1.js';
import { prompt as dailyPrompt } from '../prompts/daily-summary-v1.js';
import { transcriptionOptions } from '../prompts/transcription-v1.js';
import { guarded, ServiceError } from './errors.js';

function requiredText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ServiceError('openai', 'EMPTY_RESPONSE');
  return value.trim();
}

export function createOpenAIService(config, { client } = {}) {
  client ??= new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0, timeout: config.httpTimeoutMs });
  const summarize = (model, instructions, input) => guarded('openai', async () => {
    const result = await client.responses.create({ model, instructions, input, store: false });
    // Incomplete outputs must never be persisted as successful summaries.
    if (result.status && result.status !== 'completed') throw new ServiceError('openai', 'INCOMPLETE_RESPONSE');
    if (result.output?.some((item) => item.content?.some((part) => part.type === 'refusal'))) {
      throw new ServiceError('openai', 'MODEL_REFUSAL');
    }
    return requiredText(result.output_text);
  });
  return {
    transcribe: (audioPath, { model = config.transcriptionModel } = {}) => guarded('openai', async () => {
      const stream = createReadStream(audioPath);
      try {
        const result = await client.audio.transcriptions.create({ file: stream, model, ...transcriptionOptions });
        return requiredText(result.text);
      } finally { stream.destroy(); }
    }),
    summarizeEntry: (transcript, { model = config.entrySummaryModel } = {}) => summarize(
      model, entryPrompt, JSON.stringify({ transcript: requiredText(transcript) }),
    ),
    summarizeDay: (entries, { model = config.dailySummaryModel, date } = {}) => summarize(
      model, dailyPrompt, JSON.stringify({ date, transcripts: [...entries].sort((a, b) =>
        Date.parse(a.received_at) - Date.parse(b.received_at) || a.entry_id.localeCompare(b.entry_id))
        .map(({ received_at, entry_id, transcript }) => ({ received_at, entry_id, transcript: requiredText(transcript) })) }),
    ),
  };
}
