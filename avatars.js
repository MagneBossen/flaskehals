// Player avatars — mascot logo tiles (WebP) from ipaslogo.com (free for
// commercial use). Files live in public/avatars/<id>.webp, each self-contained
// (its own coloured square background). Assigned at random on join by the
// server; a player can swap to any free one from their own card in the lobby.
//
// The id list is a single source of truth: public/avatar-ids.json, read by the
// server (require) and here (fetch). Add a WebP + its id there and it works
// everywhere. 50 icons for a 20-player cap so the pool never dries up.

export const AVATAR_IDS = await fetch('/avatar-ids.json')
  .then((r) => r.json())
  .catch(() => []);

export function avatarImg(id) {
  const safe = AVATAR_IDS.includes(id) ? id : (AVATAR_IDS[0] || id);
  return `<img src="/avatars/${safe}.webp" alt="" draggable="false">`;
}
