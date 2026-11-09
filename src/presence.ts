import { ID_PATTERN, POSE_BOUNDS } from "./constants.js";
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
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
}

// `loadout` { car, level }: the equipped car id ("" = none) and the level shown on the name plate.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (m.car === "" || (typeof m.car === "string" && ID_PATTERN.test(m.car))) p.car = m.car as string;
  if (finite(m.level)) p.level = clamp(Math.floor(m.level), 1, 1e6);
}
