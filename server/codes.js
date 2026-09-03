// Room codes get shouted across a room, so the alphabet drops the characters
// people mishear (O/0, I/1) — kept identical to Vinylle's for muscle memory.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// Substrings we never want to hand someone as a room code. Short and blunt on
// purpose — this is a spoken 6-letter code, not a chat filter.
const BLOCKLIST = [
  'FUCK', 'SHIT', 'CUNT', 'FAG', 'NIGG', 'SLUT', 'RAPE', 'KKK', 'NAZI',
  'DICK', 'COCK', 'TWAT', 'WANK', 'JIZZ', 'PISS',
  // Danish
  'KUSSE', 'FISSE', 'PIK', 'LORT', 'LUDER', 'BOSSE', 'SPASSER', 'RETARD',
];

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function isClean(code) {
  return !BLOCKLIST.some((bad) => code.includes(bad));
}

// `taken` is a predicate so the caller stays the owner of the room map.
function freshCode(taken) {
  let code;
  do {
    code = randomCode();
  } while (!isClean(code) || taken(code));
  return code;
}

module.exports = { ALPHABET, CODE_LENGTH, freshCode, isClean };
