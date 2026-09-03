// A small pool of CSS loaders for the lobby's ambient motion and the
// waking-server screen. One is picked at random per page load and stays put.
// Each is adapted from a uiverse.io component (all MIT) into the brutalist
// palette; the scoped CSS lives in styles.css under `.ld-<id>`.
//
//   domino  — satyamchaudharydev / splendid-husky-54
//   cradle  — dovatgabriel      / jolly-kangaroo-36
//   rings   — Li-Deheng         / bright-firefox-37
//   ball    — dovatgabriel      / massive-vampirebat-17
//   capy    — Novaxlo           / kind-snail-5

const spans = (n) => Array.from({ length: n }, () => '<span></span>').join('');

const MARKUP = {
  domino: () => `<div class="ld ld-domino">${spans(8)}</div>`,
  cradle: () => `<div class="ld ld-cradle">${'<div></div>'.repeat(4)}</div>`,
  rings: () => `<div class="ld ld-rings">${
    '<div class="c"><i class="d"></i><i class="o"></i></div>'.repeat(4)
  }</div>`,
  ball: () => `<div class="ld ld-ball"><div class="bar"><div class="ball"></div></div></div>`,
  capy: () => `
    <div class="ld ld-capy">
      <div class="capybara">
        <div class="capyhead">
          <div class="capyear"><div class="capyear2"></div></div>
          <div class="capyear"></div>
          <div class="capymouth"><div class="capylips"></div><div class="capylips"></div></div>
          <div class="capyeye"></div>
          <div class="capyeye"></div>
        </div>
        <div class="capyleg"></div>
        <div class="capyleg2"></div>
        <div class="capyleg2"></div>
        <div class="capy"></div>
      </div>
      <div class="capyfloor"><div class="capyline"></div></div>
    </div>`,
};

export const LOADER_IDS = Object.keys(MARKUP);

// Chosen once per page load so it doesn't flip on every re-render.
// `?loader=<id>` pins one, for testing.
const forced = new URLSearchParams(location.search).get('loader');
export const activeLoaderId = MARKUP[forced]
  ? forced
  : LOADER_IDS[Math.floor(Math.random() * LOADER_IDS.length)];

export function loaderMarkup(id = activeLoaderId) {
  return (MARKUP[id] || MARKUP.domino)();
}
