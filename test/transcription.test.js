import test from 'node:test';
import assert from 'node:assert/strict';
import { getVocabularyProfiles, applyTranscriptionCorrections } from '../src/transcription/vocabulary.js';
import { getTranscriptionSettings, prompt } from '../src/prompts/transcription-v3.js';

const profile = 'corn-quorn-v1';
const { protectedPhrases } = getVocabularyProfiles([profile])[0];
const correct = text => applyTranscriptionCorrections(text, [profile]);

test('personal vocabulary protects every allowed phrase while correcting adjacent standalone corn', () => {
  assert.deepEqual(protectedPhrases, ['corn cakes', 'pop corn', 'corn flakes', 'sweetcorn', 'sweet corn', 'corn on the cob']);
  for (const phrase of protectedPhrases) {
    for (const version of [phrase, phrase.toUpperCase(), phrase.replaceAll(' ', '-'), phrase.replaceAll(' ', '\n')]) {
      assert.equal(correct(`Corn, ${version}, then corn.`), `Quorn, ${version}, then Quorn.`);
    }
  }
  assert.equal(correct('No corn today. Maybe CORN tomorrow? Corn-based pieces.'),
    'No Quorn today. Maybe Quorn tomorrow? Quorn-based pieces.');
  assert.equal(correct('popcorn, cornflakes, acorn, scorn, corned, cornflower, corn_123, corn2, écorn, cornée, Quorn'),
    'popcorn, cornflakes, acorn, scorn, corned, cornflower, corn_123, corn2, écorn, cornée, Quorn');
});

test('Q spelling asides resolve to Quorn without removing uncertainty, negation or list punctuation', () => {
  for (const phrase of ['corn with a Q', 'Quorn with a Q', 'CORN WITH Q', 'corn with the letter Q',
    'corn (with a Q)', 'corn, with a Q', 'corn,with a Q', 'corn—with a Q', 'corn with a "Q"', 'corn with a ‘Q’']) {
    assert.equal(correct(`Maybe ${phrase}, corn flakes and rice; I did not finish it.`),
      'Maybe Quorn, corn flakes and rice; I did not finish it.');
  }
  assert.equal(correct('Quorn with a Q, corn with a Q. A question about Q remains.'),
    'Quorn, Quorn. A question about Q remains.');
  assert.equal(correct('corn with a question'), 'Quorn with a question');
  assert.equal(correct('I said "corn with a Q", not the other food.'), 'I said "Quorn", not the other food.');
  const corrected = correct('Corn, corn flakes, sweet corn and Quorn with a Q.');
  assert.equal(correct(corrected), corrected);
});

test('correction profiles are opt-in and unsupported saved versions fail rather than changing source silently', () => {
  const text = 'corn with a Q and corn flakes';
  assert.equal(applyTranscriptionCorrections(text), text);
  assert.equal(applyTranscriptionCorrections(text, []), text);
  assert.equal(applyTranscriptionCorrections(text, [profile]), 'Quorn and corn flakes');
  for (const invalid of ['unknown-profile', ['unknown-profile'], [profile, profile], ['toString'], null]) {
    assert.throws(() => applyTranscriptionCorrections(text, invalid), { code: 'CONFIGURATION_ERROR' });
  }
});

test('an explicit C clarification overrides the personal default and is removed before summaries', () => {
  assert.equal(correct('corn with a C, corn with a Q, corn pieces and corn flakes.'),
    'corn, Quorn, Quorn pieces and corn flakes.');
  assert.equal(correct('Corn (with the letter C), then quorn with a “C”.'), 'Corn, then corn.');
});

test('base prompt is general and only selected profiles add vocabulary instructions and keyword hints', () => {
  const standard = getTranscriptionSettings('gpt-transcribe');
  assert.equal(standard.version, '3');
  assert.equal(standard.options.prompt, prompt);
  assert.doesNotMatch(standard.options.prompt, /\bcorn\b|\bQuorn\b/i);
  assert.equal(standard.options.keywords, undefined);
  assert.equal(standard.options.correction_profiles, undefined);
  const personal = getTranscriptionSettings('gpt-transcribe', { transcriptionCorrections: ['corn-quorn-v1'] });
  assert.deepEqual(personal.options.correction_profiles, [profile]);
  assert.deepEqual(personal.options.keywords, ['Quorn', 'corn']);
  assert.ok(personal.options.prompt.startsWith(`${prompt}\n\n`));
  for (const phrase of protectedPhrases) assert.ok(personal.options.prompt.includes(phrase));
  assert.match(personal.options.prompt, /spelling clarification, not another food/);
  const legacy = getTranscriptionSettings('other-model', { transcriptionCorrections: ['corn-quorn-v1'] });
  assert.equal(legacy.version, '1');
  assert.equal(legacy.options.prompt, undefined);
  assert.equal(legacy.options.keywords, undefined);
  assert.deepEqual(legacy.options.correction_profiles, [profile]);
});
