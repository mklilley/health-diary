import { version as previousVersion, transcriptionOptions as previousOptions } from './transcription-v1.js';

export const version = '2';
export const prompt = `This is a food and symptom diary. Food names may include Quorn
(Q-U-O-R-N), the meat-substitute brand, and corn (C-O-R-N), as in corn on the cob.
The speaker may distinguish these similar-sounding words by saying "with a Q"
for Quorn or "with a C" for corn, or by spelling the word aloud. Use these spoken
clarifications to choose the spelling. Preserve the clarifications, corrections,
and uncertainty in the transcript. Without a spelling clarification, use the
surrounding context; do not automatically change corn to Quorn. These vocabulary
hints do not mean either food was mentioned: include only what was spoken.`;

export const transcriptionOptions = Object.freeze({
  response_format: 'json',
  prompt,
  keywords: Object.freeze(['Quorn', 'corn']),
});

export function getTranscriptionSettings(model) {
  // Keyword hints are supported by GPT Transcribe; keep other models' existing requests.
  return model === 'gpt-transcribe'
    ? { version, options: transcriptionOptions }
    : { version: previousVersion, options: previousOptions };
}
