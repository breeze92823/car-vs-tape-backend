import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // Presence (presence.ts, `pose` / `loadout`): what the others can draw in the world.
    x: t.float64().default(0),
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing north / the gate)
    speed: t.float32().default(0), // m/s along the nose, signed (the wheels' speed: a treadmill reports its belt speed)
    steer: t.float32().default(0), // -1..1 steering input (front wheels + the driver's hands)
    thr: t.float32().default(0), // -1..1 throttle (exhaust, brake lights)
    flags: t.uint8().default(0), // pose flag bits: braking 1, drifting 2, handbrake 4, treadmill 8, boosted 16, stunned 32, rocket (Shift boost) 64, flying 128
    emote: t.uint8().default(0), // the driver's last gesture: 1 cheer, 2 wave, 3 honk (counted by emoteN)
    emoteN: t.uint16().default(0), // bumps with every emote so the same gesture can repeat
    car: t.string().default(""), // equipped car id (client CARS), "" = default
    level: t.uint32().default(1), // for the name plate
    uid: t.string().default(""), // Bloxity user id of a signed-in player ("" = guest): matches portal chat messages to a car
    // The driver's look (presence.ts `avatar`): JSON of SDK.avatar.getEquipped() / getProportions() and the
    // composed skin texture URL, so the others can dress the same avatar in the seat.
    avatar: t.string().default(""),
    props: t.string().default(""),
    skin: t.string().default(""),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
