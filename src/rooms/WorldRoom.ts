import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, PLAY_SAVE_EVERY_MS, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { applyLoadout, applyPose } from "../presence.js";
import { queueReport, verifyAdReward } from "../bloxity.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { PlayClock, playRewardMs } from "../playtime.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // Free Boost chest (playtime.ts): signed-in sessions' play clocks and chest counts. Guests have none.
  private play = new Map<string, PlayClock>();
  private claims = new Map<string, number>();
  // sessionIds whose tab is hidden (`playActive` false): their clock is stopped.
  private hidden = new Set<string>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The best tape and lifetime Wins only ever go up ($max), so a stale or replayed save can't lower them.
      const { bestTape, totalWins, ...rest } = patch;
      const max = { ...(bestTape !== undefined && { bestTape }), ...(totalWins !== undefined && { totalWins }) };
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            // playMs is the server's own count, never the client's.
            $set: { ...rest, ...this.playPatch(client.sessionId), username: p.username || "Player", updatedAt: new Date() },
            ...(Object.keys(max).length > 0 && { $max: max }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
        // Leaderboards + profile stats go to Boxity from here (bloxity.ts), batched.
        queueReport(userId, patch);
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Rewarded ad finished on the client: Boxity checks the single-use token, then the client may
    // grant the reward. Answers `adRewardResult` { ok }.
    adReward: async (client: Client, msg: { rewardToken?: unknown }) => {
      client.send("adRewardResult", { ok: await verifyAdReward(msg?.rewardToken) });
    },
    // The tab was hidden / shown: the chest's play clock only runs while the game is on screen.
    playActive: (client: Client, msg: { active?: unknown }) => {
      const active = msg?.active !== false;
      if (active) this.hidden.delete(client.sessionId);
      else this.hidden.add(client.sessionId);
      this.play.get(client.sessionId)?.setActive(active);
    },
    // The car drove into the Free Boost chest. Only a signed-in Bloxity account whose save has
    // loaded and who has played the full hour may open it; the count then starts again. Answers
    // `chestResult` { ok, reason?: "signin" | "loading" | "early", ...playtime status }. The client
    // grants the reward (Wins + boost) on ok, like the rewarded ad.
    claimChest: async (client: Client) => {
      const sid = client.sessionId;
      const userId = this.userIds.get(sid);
      const clock = this.play.get(sid);
      if (!userId) return client.send("chestResult", { ok: false, reason: "signin", ...this.playStatus(sid) });
      if (!clock || !this.loaded.has(sid)) return client.send("chestResult", { ok: false, reason: "loading", ...this.playStatus(sid) });
      if (!clock.take()) return client.send("chestResult", { ok: false, reason: "early", ...this.playStatus(sid) });
      const claims = (this.claims.get(sid) ?? 0) + 1;
      this.claims.set(sid, claims);
      client.send("chestResult", { ok: true, ...this.playStatus(sid) });
      const players = getPlayers();
      if (!players) return;
      try {
        await players.updateOne({ _id: userId }, { $set: { playMs: 0, chestClaims: claims }, $setOnInsert: { version: 1 } }, { upsert: true });
      } catch (err) {
        console.warn("[WorldRoom] claimChest save failed", err);
      }
    },
    // Presence (presence.ts): the sender's pose ~10x/s and its car, relayed through the roster.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    // Play clocks are also saved on their own, so a parked player (no progress saves) or a server
    // restart loses at most PLAY_SAVE_EVERY_MS of the hour.
    this.clock.setInterval(() => {
      for (const sid of this.play.keys()) void this.savePlay(sid);
    }, PLAY_SAVE_EVERY_MS);
  }

  // `playtime` / `chestResult` payload: { signedIn, playMs, needMs, claims, active }.
  private playStatus(sessionId: string) {
    const clock = this.play.get(sessionId);
    return {
      signedIn: this.userIds.has(sessionId),
      playMs: clock?.ms() ?? 0,
      needMs: playRewardMs(),
      claims: this.claims.get(sessionId) ?? 0,
      active: clock?.active ?? false,
    };
  }
  private sendPlaytime(client: Client) {
    try {
      client.send("playtime", this.playStatus(client.sessionId));
    } catch {
      // Gone meanwhile.
    }
  }
  private playPatch(sessionId: string): { playMs?: number } {
    const clock = this.play.get(sessionId);
    return clock && this.loaded.has(sessionId) ? { playMs: clock.ms() } : {};
  }
  // Reads the clock synchronously (before any await), so callers may drop the session right after.
  private async savePlay(sessionId: string, userId = this.userIds.get(sessionId)) {
    const patch = this.playPatch(sessionId);
    const players = getPlayers();
    if (!userId || !players || patch.playMs === undefined) return;
    try {
      await players.updateOne({ _id: userId }, { $set: patch });
    } catch (err) {
      console.warn("[WorldRoom] savePlay failed", err);
    }
  }

  // `leaderboard` { boards: { power|wins|rebirths: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; pfp?: string; pose?: unknown; loadout?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, typeof options?.userId === "string" ? options.userId : "");
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    // A dropped connection is not playing: the chest clock waits for the reconnect.
    this.play.get(client.sessionId)?.setActive(false);
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
      this.play.get(client.sessionId)?.setActive(!this.hidden.has(client.sessionId));
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now(), ...this.playPatch(sessionId) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.play.delete(sessionId);
    this.claims.delete(sessionId);
    this.hidden.delete(sessionId);
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    // The old identity's chest clock is saved and stopped; the new one's is read with its save.
    if (prev) void this.savePlay(client.sessionId, prev);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    p.signedIn = !!userId;
    this.play.delete(client.sessionId);
    this.claims.delete(client.sessionId);
    // An evicted session's clock carries over (its own save may land after this load reads).
    let carry = { playMs: 0, claims: 0 };

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        carry = { playMs: Math.max(carry.playMs, this.play.get(sid)?.ms() ?? 0), claims: Math.max(carry.claims, this.claims.get(sid) ?? 0) };
        void this.savePlay(sid);
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p, carry);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState, carry = { playMs: 0, claims: 0 }) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });

    // Signed-in accounts (also without a database: then the clock lives for this session) start
    // their chest clock from the saved count.
    if (userId) {
      const saved = typeof doc?.playMs === "number" ? doc.playMs : 0;
      this.play.set(client.sessionId, new PlayClock(Math.max(saved, carry.playMs), !this.hidden.has(client.sessionId), now));
      this.claims.set(client.sessionId, Math.max(typeof doc?.chestClaims === "number" ? doc.chestClaims : 0, carry.claims));
    }
    this.sendPlaytime(client);
    void this.sendLeaderboard(client);
  }
}
