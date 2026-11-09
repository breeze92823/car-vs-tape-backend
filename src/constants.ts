// Keep in step with the client's src/config.js by hand (CARS, TRACK, ECONOMY).
export const ROOM_MAX_CLIENTS = 50;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): pose bounds (|x|, |y|, |z| up to `xy` m; speed in m/s).
export const POSE_BOUNDS = { xy: 5000, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const CURRENCY_MAX = 1e33; // power, wins, totalWins
export const REBIRTHS_MAX = 1e6;
export const LEVEL_MAX = 1e6;
export const XP_MAX = 1e15;
export const TAPES_MAX = 1000; // bestTape index ceiling (client TRACK.tapes)
// Owned car ids (client CARS, 12 of them), with slack.
export const OWNED_MAX = 64;
// Boost timestamps (epoch ms) may sit at most this far in the future (client boost cooldown is 5 min).
export const BOOST_FUTURE_MS = 24 * 60 * 60 * 1000;

// Leaderboards (leaderboard.ts; client town.js boards): the saved doc fields ranked
// (Top Power, Top Wins, Top Rebirths), rows per board and how often they are re-read and re-sent.
export const LEADERBOARD_STATS = ["power", "wins", "rebirths"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Free Boost chest (playtime.ts): how often every signed-in player's play clock is saved.
export const PLAY_SAVE_EVERY_MS = 60 * 1000;

// Car ids from the client's CARS: slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
// The default car every account owns (client game.js).
export const DEFAULT_CAR = "pebble";

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
