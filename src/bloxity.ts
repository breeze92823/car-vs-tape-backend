import { GUEST_ID_PREFIX } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Boxity (Legion) platform calls made from state THIS server owns (never from a client packet):
//  - leaderboards: POST {api}/v1/leaderboards/hosted/{gameId}/report  (Bearer BLOXITY_REPORT_TOKEN)
//  - profile stats ("Only in this game"): POST {api}/v1/games/{gameId}/stats
//  - rewarded-ad token check: POST {api}/v1/ads/reward/verify
// Hosting injects BLOXITY_REPORT_TOKEN, BLOXITY_GAME_ID and BLOXITY_API_URL. Without the token or
// the game id (local development) every report is a no-op.

export const REPORT_EVERY_MS = 60 * 1000;
export const REPORT_BATCH = 200; // both endpoints take at most 200 entries per call

// The client's board ids / stat keys (client config.js BOARDS). Leaderboards rank the saved doc
// fields of the same name; labels must match the client's `leaderboard.define`.
export const BOARDS = [
  { id: "power", label: "Power", format: "compact", field: "power" },
  { id: "wins", label: "Wins", format: "compact", field: "wins" },
  { id: "rebirths", label: "Rebirths", format: "number", field: "rebirths" },
] as const;

// Profile stats (Boxity stores the last value sent and the all-time high). Limits per type are
// rejected, not clamped: number 1e9, currency 1e12, percent 100.
const STAT_LIMIT = { number: 1e9, currency: 1e12 } as const;
export const STATS = [
  { key: "level", label: "Level", type: "number", sortOrder: 1, get: (d: Partial<PlayerDoc>) => d.level },
  { key: "rebirths", label: "Rebirths", type: "number", sortOrder: 2, get: (d: Partial<PlayerDoc>) => d.rebirths },
  { key: "tapes_snapped", label: "Tapes Snapped", type: "number", sortOrder: 3, get: (d: Partial<PlayerDoc>) => (d.bestTape === undefined ? undefined : d.bestTape + 1) },
  { key: "wins", label: "Wins", type: "currency", sortOrder: 4, get: (d: Partial<PlayerDoc>) => d.wins },
  { key: "total_wins", label: "Total Wins", type: "currency", sortOrder: 5, get: (d: Partial<PlayerDoc>) => d.totalWins },
  { key: "power", label: "Power", type: "number", sortOrder: 6, get: (d: Partial<PlayerDoc>) => d.power },
] as const;

const env = () => ({
  token: process.env.BLOXITY_REPORT_TOKEN || "",
  gameId: process.env.BLOXITY_GAME_ID || "",
  api: (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, ""),
});
export const reportingEnabled = () => !!(env().token && env().gameId);

// Only Boxity accounts rank: guests (and the client's dev ids) have none.
const boxityId = (userId: string) => (!userId || userId.startsWith(GUEST_ID_PREFIX) || userId.startsWith("dev-") ? "" : `legion_${userId}`);

let doFetch: typeof fetch = (...a) => fetch(...a);
export function __setFetchForTest(f: typeof fetch | null): void {
  doFetch = f ?? ((...a) => fetch(...a));
}

// userId -> the latest values seen since the last report.
const pending = new Map<string, Partial<PlayerDoc>>();
let timer: ReturnType<typeof setInterval> | null = null;

// Remember a signed-in player's saved values; they go out with the next report.
export function queueReport(userId: string, doc: Partial<PlayerDoc>): void {
  if (!reportingEnabled() || !boxityId(userId)) return;
  pending.set(userId, { ...pending.get(userId), ...doc });
  if (!timer) {
    timer = setInterval(() => void flushReports(), REPORT_EVERY_MS);
    timer.unref?.();
  }
}

const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// Sends everything queued, in batches. Never throws.
export async function flushReports(): Promise<void> {
  const { token, gameId, api } = env();
  if (!token || !gameId || pending.size === 0) return;
  const entries = [...pending.entries()];
  pending.clear();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  for (let i = 0; i < entries.length; i += REPORT_BATCH) {
    const batch = entries.slice(i, i + REPORT_BATCH);

    const scores: { board: string; userId: string; score: number }[] = [];
    const players: { userId: string; values: Record<string, number> }[] = [];
    for (const [userId, doc] of batch) {
      const id = boxityId(userId);
      for (const b of BOARDS) {
        const v = doc[b.field];
        if (finiteNonNeg(v)) scores.push({ board: b.id, userId: id, score: v });
      }
      const values: Record<string, number> = {};
      for (const s of STATS) {
        const v = s.get(doc);
        if (finiteNonNeg(v) && v <= STAT_LIMIT[s.type]) values[s.key] = v;
      }
      if (Object.keys(values).length) players.push({ userId: id, values });
    }

    try {
      if (scores.length) {
        await doFetch(`${api}/v1/leaderboards/hosted/${encodeURIComponent(gameId)}/report`, {
          method: "POST",
          headers,
          body: JSON.stringify({ boards: BOARDS.map((b) => ({ id: b.id, label: b.label, mode: "best", format: b.format, reset: "none" })), scores }),
        });
      }
      if (players.length) {
        await doFetch(`${api}/v1/games/${encodeURIComponent(gameId)}/stats`, {
          method: "POST",
          headers,
          body: JSON.stringify({ definitions: STATS.map(({ key, label, type, sortOrder }) => ({ key, label, type, sortOrder })), players }),
        });
      }
    } catch (err) {
      console.warn("[bloxity] report failed", err);
    }
  }
}

// Checks a rewarded-ad token from a client. True only for a valid, single-use token for this game.
// Without a game id (local development) there is nothing to verify against: false.
export async function verifyAdReward(rewardToken: unknown): Promise<boolean> {
  const { gameId, api } = env();
  if (!gameId || typeof rewardToken !== "string" || rewardToken.length === 0 || rewardToken.length > 2048) return false;
  try {
    const res = await doFetch(`${api}/v1/ads/reward/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameSlug: gameId, rewardToken }),
    });
    const v = (await res.json()) as { valid?: boolean };
    return v?.valid === true;
  } catch (err) {
    console.warn("[bloxity] ad reward verify failed", err);
    return false;
  }
}
