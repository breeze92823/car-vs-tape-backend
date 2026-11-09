// Playtime rewards for signed-in Bloxity players, counted here so a client can't fast-forward them.
// Each clock runs while the player is connected with the tab visible (`playActive`), stops at its
// goal (no banking hours of AFK into several rewards) and is saved on the player's doc, so it carries
// over to the next session -- the reason to come back and finish it.
//   - Free Boost chest (client town.js chest): every playRewardMs() of play (1 h). Doc: playMs, chestClaims.
//   - Free car (client town.js gift podium): the next car above the player's best, after
//     carGiftMs(gifts) of play (30 min, +15 min per car already gifted, at most 2 h).
//     Doc: carPlayMs, carGifts, giftedCars (ids; also added to `owned`, and merged back into it on load).

// PLAY_REWARD_MS / CAR_GIFT_MS (env) shorten the goals for local testing.
function envMs(name: string, def: number): number {
  const env = Number(process.env[name]);
  return Number.isFinite(env) && env > 0 ? env : def;
}
export function playRewardMs(): number {
  return envMs("PLAY_REWARD_MS", 60 * 60 * 1000);
}
export function carGiftMs(gifts: number): number {
  return Math.round(envMs("CAR_GIFT_MS", 30 * 60 * 1000) * Math.min(4, 1 + 0.5 * Math.max(0, gifts)));
}

export class PlayClock {
  private base: number; // ms counted before `since`
  private since = 0; // epoch ms the clock last started; 0 = stopped

  constructor(playMs: number, active: boolean, public goal: number, now = Date.now()) {
    this.base = Number.isFinite(playMs) ? Math.min(Math.max(0, playMs), goal) : 0;
    if (active) this.since = now;
  }

  get active(): boolean {
    return this.since > 0;
  }

  // Play counted toward the goal, capped at it.
  ms(now = Date.now()): number {
    return Math.min(this.goal, this.base + (this.since ? Math.max(0, now - this.since) : 0));
  }

  setActive(on: boolean, now = Date.now()) {
    if (on === this.active) return;
    this.base = this.ms(now);
    this.since = on ? now : 0;
  }

  // Once the goal is reached: the count starts again from zero (toward `nextGoal`).
  take(now = Date.now(), nextGoal = this.goal): boolean {
    if (this.ms(now) < this.goal) return false;
    this.base = 0;
    this.goal = nextGoal;
    if (this.since) this.since = now;
    return true;
  }
}

// The saved fields (PlayerDoc).
export interface PlayDoc {
  playMs?: number;
  chestClaims?: number;
  carPlayMs?: number;
  carGifts?: number;
  giftedCars?: string[];
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);

// One signed-in session's reward clocks.
export class PlayRewards {
  chest: PlayClock;
  car: PlayClock;
  claims: number;
  gifts: number;
  gifted: string[];

  // `carry` = an evicted session of the same account (its own save may land after this load).
  constructor(doc: PlayDoc | null, active: boolean, carry?: PlayDoc, now = Date.now()) {
    this.claims = Math.max(count(doc?.chestClaims), count(carry?.chestClaims));
    this.gifts = Math.max(count(doc?.carGifts), count(carry?.carGifts));
    this.gifted = [...new Set([...(doc?.giftedCars ?? []), ...(carry?.giftedCars ?? [])].filter((id) => typeof id === "string"))];
    this.chest = new PlayClock(Math.max(ms(doc?.playMs), ms(carry?.playMs)), active, playRewardMs(), now);
    this.car = new PlayClock(Math.max(ms(doc?.carPlayMs), ms(carry?.carPlayMs)), active, carGiftMs(this.gifts), now);
  }

  get active(): boolean {
    return this.chest.active;
  }
  setActive(on: boolean, now = Date.now()) {
    this.chest.setActive(on, now);
    this.car.setActive(on, now);
  }

  // `playtime` / result payload (without signedIn).
  status(now = Date.now()) {
    return {
      playMs: this.chest.ms(now),
      needMs: this.chest.goal,
      claims: this.claims,
      active: this.active,
      car: { playMs: this.car.ms(now), needMs: this.car.goal, gifts: this.gifts, gifted: this.gifted },
    };
  }

  // What is saved with each progress save / on leave.
  clocks(now = Date.now()) {
    return { playMs: this.chest.ms(now), carPlayMs: this.car.ms(now) };
  }
  snapshot(now = Date.now()): PlayDoc {
    return { ...this.clocks(now), chestClaims: this.claims, carGifts: this.gifts, giftedCars: [...this.gifted] };
  }

  takeChest(now = Date.now()): boolean {
    if (!this.chest.take(now)) return false;
    this.claims++;
    return true;
  }
  // `car` is the client's pick (the next car above its best); each car is gifted at most once.
  takeCar(car: string, now = Date.now()): "ok" | "early" | "owned" {
    if (this.gifted.includes(car)) return "owned";
    if (!this.car.take(now, carGiftMs(this.gifts + 1))) return "early";
    this.gifts++;
    this.gifted.push(car);
    return "ok";
  }
}
