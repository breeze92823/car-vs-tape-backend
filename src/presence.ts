import { AVATAR_JSON_MAX, EMOTE_KINDS, ID_PATTERN, POSE_BOUNDS, SKIN_HOSTS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world. Relayed through the
// roster as sent, only bounded here -- client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// `pose` { x, y, z, yaw, speed }: the car's position (m), heading (rad) and speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.xy, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, -b.speed, b.speed);
  if (finite(m.steer)) p.steer = clamp(m.steer, -1, 1);
  if (finite(m.thr)) p.thr = clamp(m.thr, -1, 1);
  if (finite(m.flags)) p.flags = Math.floor(clamp(m.flags, 0, 255));
}

// `emote` { kind }: 1 cheer, 2 wave, 3 honk. Counted, so the others see every repeat.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const kind = msg && typeof msg === "object" ? (msg as Record<string, unknown>).kind : 0;
  if (!finite(kind) || kind < 1 || kind > EMOTE_KINDS) return;
  p.emote = Math.floor(kind);
  p.emoteN = (p.emoteN + 1) & 0xffff;
}

// A flat { key: short string | number } object as JSON ("" when it is not one or is too long).
function flatJson(raw: unknown, maxKeys: number): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, maxKeys)) {
    if (!/^[A-Za-z0-9_]{1,24}$/.test(k)) continue;
    if (typeof v === "string" && v.length <= 64) out[k] = v;
    else if (finite(v)) out[k] = clamp(v, -1e9, 1e9);
  }
  const json = JSON.stringify(out);
  return json.length <= AVATAR_JSON_MAX ? json : "";
}

// `avatar` { equipped, proportions, skin }: what the player's Bloxity avatar wears (the SDK's getEquipped /
// getProportions shapes) and its composed skin texture URL (only from Bloxity's own hosts).
export function applyAvatar(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  p.avatar = flatJson(m.equipped, 40);
  p.props = flatJson(m.proportions, 16);
  let skin = "";
  if (typeof m.skin === "string" && m.skin.length <= 512) {
    try {
      const u = new URL(m.skin);
      if (u.protocol === "https:" && SKIN_HOSTS.includes(u.hostname)) skin = u.href;
    } catch {
      // Not a URL.
    }
  }
  p.skin = skin;
}

// `loadout` { car, level }: the equipped car id ("" = none) and the level shown on the name plate.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (m.car === "" || (typeof m.car === "string" && ID_PATTERN.test(m.car))) p.car = m.car as string;
  if (finite(m.level)) p.level = clamp(Math.floor(m.level), 1, 1e6);
}
