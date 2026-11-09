import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  power?: number; // trained Power (client state.power)
  wins?: number; // spendable Wins (cars, rebirth)
  totalWins?: number; // Wins ever earned
  level?: number;
  xp?: number; // xp into the current level
  rebirths?: number;
  owned?: string[]; // owned car ids (client CARS)
  car?: string; // the equipped car (an owned one)
  bestTape?: number; // highest tape index ever snapped, -1 = none
  boostUntil?: number; // epoch ms the x2 power boost ends
  boostReadyAt?: number; // legacy: the old 5-min chest cooldown (clients no longer send it)
  playMs?: number; // server-counted play toward the next Free Boost chest (playtime.ts), never from the client
  chestClaims?: number; // Free Boost chests opened
  carPlayMs?: number; // server-counted play toward the next free car (playtime.ts)
  carGifts?: number; // free cars given
  giftedCars?: string[]; // their ids (always merged back into `owned` on load)
  lastSeen?: number; // epoch ms of the last activity
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
