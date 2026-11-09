import { BOOST_FUTURE_MS, CURRENCY_MAX, DEFAULT_CAR, ID_PATTERN, LEVEL_MAX, OWNED_MAX, REBIRTHS_MAX, TAPES_MAX, XP_MAX } from "./constants.js";
import type { PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Car ids: slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.power)) out.power = clampNum(raw.power, CURRENCY_MAX);
  if (finite(raw.wins)) out.wins = clampNum(raw.wins, CURRENCY_MAX);
  if (finite(raw.totalWins)) out.totalWins = clampNum(raw.totalWins, CURRENCY_MAX);
  if (finite(raw.level)) out.level = clampInt(raw.level, LEVEL_MAX, 1);
  if (finite(raw.xp)) out.xp = clampNum(raw.xp, XP_MAX);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (finite(raw.bestTape)) out.bestTape = clampInt(raw.bestTape, TAPES_MAX, -1);
  if (typeof raw.autoDrive === "boolean") out.autoDrive = raw.autoDrive;
  const horizon = Date.now() + BOOST_FUTURE_MS;
  if (finite(raw.boostUntil)) out.boostUntil = clampInt(raw.boostUntil, horizon);
  if (finite(raw.boostReadyAt)) out.boostReadyAt = clampInt(raw.boostReadyAt, horizon);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);

  // Every account owns the default car; the equipped one must be owned.
  if (raw.owned !== undefined) {
    const owned = sanitizeIds(raw.owned);
    if (!owned.includes(DEFAULT_CAR)) owned.unshift(DEFAULT_CAR);
    out.owned = owned.slice(0, OWNED_MAX);
  }
  if (isId(raw.car) && (!out.owned || out.owned.includes(raw.car))) out.car = raw.car;
  return out;
}
