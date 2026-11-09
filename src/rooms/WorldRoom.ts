import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { GUEST_ID_PREFIX, ID_PATTERN, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, PLAY_SAVE_EVERY_MS, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeIds, sanitizeProgress } from "../sanitize.js";
import { applyAvatar, applyEmote, applyLoadout, applyPose } from "../presence.js";
import { queueReport, verifyAdReward } from "../bloxity.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { PlayRewards, type PlayDoc } from "../playtime.js";

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
  // Playtime rewards (playtime.ts: Free Boost chest + free car): signed-in sessions' clocks, created
  // once their save has loaded. Guests have none.
  private play = new Map<string, PlayRewards>();
  // sessionIds whose tab is hidden (`playActive` false): their clocks are stopped.
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
            // The play clocks are the server's own count, never the client's.
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
    // The tab was hidden / shown: the play clocks only run while the game is on screen.
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
      const r = this.play.get(sid);
      if (!userId) return client.send("chestResult", { ok: false, reason: "signin", ...this.playStatus(sid) });
      if (!r || !this.loaded.has(sid)) return client.send("chestResult", { ok: false, reason: "loading", ...this.playStatus(sid) });
      if (!r.takeChest()) return client.send("chestResult", { ok: false, reason: "early", ...this.playStatus(sid) });
      client.send("chestResult", { ok: true, ...this.playStatus(sid) });
      await this.writeRewards(userId, { playMs: 0, chestClaims: r.claims }, "claimChest");
    },
    // The car drove onto the Free Car podium: { car } = the client's pick (the next car above its
    // best). Same gate as the chest, with the free-car clock (playtime.ts carGiftMs: 30 min and up);
    // each car id is gifted once. Answers `carResult` { ok, carId, reason?: "signin" | "loading" |
    // "early" | "owned" | "bad", ...playtime status }. On ok the car is also added to the saved
    // `owned` (and `giftedCars`, merged back into `owned` on every load), so a gift is never lost
    // even if the client's next save never arrives; the client equips it.
    claimCar: async (client: Client, msg: { car?: unknown }) => {
      const sid = client.sessionId;
      const userId = this.userIds.get(sid);
      const r = this.play.get(sid);
      const car = typeof msg?.car === "string" && ID_PATTERN.test(msg.car) ? msg.car : "";
      const answer = (ok: boolean, reason?: string) => client.send("carResult", { ...this.playStatus(sid), ok, carId: car, ...(reason && { reason }) });
      if (!car) return answer(false, "bad");
      if (!userId) return answer(false, "signin");
      if (!r || !this.loaded.has(sid)) return answer(false, "loading");
      const took = r.takeCar(car);
      if (took !== "ok") return answer(false, took);
      answer(true);
      await this.writeRewards(userId, { carPlayMs: 0, carGifts: r.gifts, giftedCars: [...r.gifted] }, "claimCar", car);
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
    // The driver's gesture (cheer / wave / honk) and Bloxity avatar look, relayed for the others to draw.
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    avatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
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

  // `playtime` / `chestResult` / `carResult` payload: { signedIn, active, playMs, needMs, claims (chest),
  // car: { playMs, needMs, gifts, gifted[] } } -- zeros for a guest or before the save has loaded.
  private playStatus(sessionId: string) {
    const r = this.play.get(sessionId);
    return {
      signedIn: this.userIds.has(sessionId),
      ...(r?.status() ?? { playMs: 0, needMs: 0, claims: 0, active: false, car: { playMs: 0, needMs: 0, gifts: 0, gifted: [] } }),
    };
  }
  // A claimed reward's counters (and a gifted car, into `owned`).
  private async writeRewards(userId: string, set: PlayDoc, what: string, car?: string) {
    const players = getPlayers();
    if (!players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: set, ...(car && { $addToSet: { owned: car } }), $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn(`[WorldRoom] ${what} save failed`, err);
    }
  }
  private sendPlaytime(client: Client) {
    try {
      client.send("playtime", this.playStatus(client.sessionId));
    } catch {
      // Gone meanwhile.
    }
  }
  private playPatch(sessionId: string): { playMs?: number; carPlayMs?: number } {
    const r = this.play.get(sessionId);
    return r && this.loaded.has(sessionId) ? r.clocks() : {};
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

  onJoin(client: Client, options?: { username?: string; userId?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options?.avatar);
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
    // The old identity's play clocks are saved and stopped; the new one's are read with its save.
    if (prev) void this.savePlay(client.sessionId, prev);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    p.signedIn = !!userId;
    p.uid = userId;
    this.play.delete(client.sessionId);
    // An evicted session's clocks carry over (its own save may land after this load reads).
    let carry: PlayDoc | undefined;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        carry = this.play.get(sid)?.snapshot() ?? carry;
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
  private async loadProgress(client: Client, userId: string, p: PlayerState, carry?: PlayDoc) {
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
    else {
      // Gifted cars are always owned, even if a stale client save dropped one.
      const progress = sanitizeProgress(doc) ?? {};
      const gifted = sanitizeIds(doc.giftedCars);
      if (gifted.length) progress.owned = sanitizeIds([...(progress.owned ?? []), ...gifted]);
      client.send("progress", { ...progress, serverTime: now });
    }

    // Signed-in accounts (also without a database: then the clocks live for this session) start
    // their reward clocks from the saved counts.
    if (userId) this.play.set(client.sessionId, new PlayRewards(doc, !this.hidden.has(client.sessionId), carry, now));
    this.sendPlaytime(client);
    void this.sendLeaderboard(client);
  }
}
