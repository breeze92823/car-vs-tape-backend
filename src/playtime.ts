// Free Boost chest (client town.js chest): a signed-in Bloxity player opens it after playRewardMs()
// of play. The server keeps the count, so a client can't fast-forward it: it runs while the player
// is connected with the tab visible (`playActive`), stops once the chest is ready (no banking hours
// of AFK into several chests), and is saved on the player's doc (`playMs`) so it carries over to the
// next session -- the reason to come back and finish the hour.

// PLAY_REWARD_MS (env) shortens the hour for local testing.
export function playRewardMs(): number {
  const env = Number(process.env.PLAY_REWARD_MS);
  return Number.isFinite(env) && env > 0 ? env : 60 * 60 * 1000;
}

export class PlayClock {
  private base: number; // ms counted before `since`
  private since = 0; // epoch ms the clock last started; 0 = stopped

  constructor(playMs: number, active: boolean, now = Date.now()) {
    this.base = Number.isFinite(playMs) ? Math.min(Math.max(0, playMs), playRewardMs()) : 0;
    if (active) this.since = now;
  }

  get active(): boolean {
    return this.since > 0;
  }

  // Play counted toward the chest, capped at the goal.
  ms(now = Date.now()): number {
    return Math.min(playRewardMs(), this.base + (this.since ? Math.max(0, now - this.since) : 0));
  }

  setActive(on: boolean, now = Date.now()) {
    if (on === this.active) return;
    this.base = this.ms(now);
    this.since = on ? now : 0;
  }

  // Opens the chest when the goal is reached: the count starts again from zero.
  take(now = Date.now()): boolean {
    if (this.ms(now) < playRewardMs()) return false;
    this.base = 0;
    if (this.since) this.since = now;
    return true;
  }
}
