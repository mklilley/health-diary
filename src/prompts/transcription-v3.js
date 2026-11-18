import { version as unpromptedVersion, transcriptionOptions as unpromptedOptions } from './transcription-v1.js';
import { getVocabularyProfiles } from '../transcription/vocabulary.js';

export const version = '3';
export const prompt = `This is a food and symptom diary. Transcribe what was spoken faithfully.
Preserve foods, drinks, symptoms, timing, substantive corrections, negations,
uncertainty and all other spoken details. Keep complete food and product names;
do not shorten them or summarise the recording. Use the surrounding context
and any explicit spelling clarifications to distinguish similar-sounding words.
Follow any vocabulary guidance below for specific spellings and clarifications.
Vocabulary hints are not evidence that a word was spoken: include only what was
said, without inventing foods, symptoms or other facts.`;

export const transcriptionOptions = Object.freeze({ response_format: 'json', prompt });

export function getTranscriptionSettings(model, { transcriptionCorrections = [] } = {}) {
  const prompted = model === 'gpt-transcribe';
  const options = prompted ? transcriptionOptions : unpromptedOptions;
  const profiles = getVocabularyProfiles(transcriptionCorrections);
  if (!profiles.length) return { version: prompted ? version : unpromptedVersion, options };
  const keywords = [...new Set(profiles.flatMap(profile => profile.keywords ?? []))];
  return {
    version: prompted ? version : unpromptedVersion,
    options: { ...options, correction_profiles: profiles.map(profile => profile.id),
      ...(prompted ? {
        prompt: [prompt, ...profiles.map(profile => profile.prompt)].join('\n\n'),
        ...(keywords.length ? { keywords } : {}),
      } : {}),
    },
  };
}
