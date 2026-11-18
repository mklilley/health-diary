// Named vocabulary profiles are selected per diary. Keep each published profile
// stable: pending recordings save its ID and reuse that version on retries.
const protectedPhrases = Object.freeze([
  'corn cakes',
  'pop corn',
  'corn flakes',
  'sweetcorn',
  'sweet corn',
  'corn on the cob',
]);

const wordCharacters = String.raw`\p{L}\p{M}\p{N}_`;
const gap = String.raw`[\s\u2010\u2011-]+`;
const allowed = protectedPhrases.map(phrase => phrase.split(' ').join(gap)).join('|');
function spellingAside(letter) {
  const quoted = `(?:${letter}|"${letter}"|'${letter}'|“${letter}”|‘${letter}’)`;
  const words = String.raw`with\s+(?:(?:a|the)\s+)?(?:letter\s+)?${quoted}`;
  // Keep any following comma: it may separate foods in a list. Quotes are
  // consumed only in balanced pairs around the letter, not around a sentence.
  return String.raw`(?:\s*\(\s*${words}\s*\)|(?:\s*[,\u2013\u2014:-]\s*|\s+)${words})`;
}
const matches = new RegExp(String.raw`(?<![${wordCharacters}])(?:(?<literal>(?:quorn|corn)${spellingAside('c')})|(?<clarified>(?:quorn|corn)${spellingAside('q')})|(?<allowed>${allowed})|(?<bare>corn))(?![${wordCharacters}])`, 'giu');

const profiles = Object.freeze({
  'corn-quorn-v1': Object.freeze({
    id: 'corn-quorn-v1',
    protectedPhrases,
    keywords: Object.freeze(['Quorn', 'corn']),
    prompt: `Food names may include Quorn (Q-U-O-R-N), the meat-substitute brand,
and corn (C-O-R-N), as in corn on the cob. Resolve "Quorn with a Q" or "corn
with a Q" to "Quorn", omitting the spelling aside. The letter Q is a spelling clarification, not another food or an unknown item.
This diary's owner uses "Quorn" for an otherwise standalone "corn".
Keep these food phrases unchanged: ${protectedPhrases.join(', ')}.
Outside those phrases, write the meat-substitute name "Quorn" for standalone "corn".
An explicit "with a C" overrides this personal default: keep the wording "corn
with a C" in your response so the application can recognise and preserve that
explicit spelling. The application will remove this spelling aside before summarising.`,
    apply: text => text.replace(matches, (...args) => {
      const { allowed, literal } = args.at(-1);
      if (literal) return /^[CQ]/.test(args[0]) ? 'Corn' : 'corn';
      return allowed ? args[0] : 'Quorn';
    }),
  }),
});

export function getVocabularyProfiles(ids = []) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !Object.hasOwn(profiles, id))
    || new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('transcriptionCorrections must be a list of distinct, supported vocabulary profile IDs'), { code: 'CONFIGURATION_ERROR' });
  }
  return ids.map(id => profiles[id]);
}

export function applyTranscriptionCorrections(text, savedProfiles = []) {
  return getVocabularyProfiles(savedProfiles).reduce((result, profile) => profile.apply(result), text);
}
