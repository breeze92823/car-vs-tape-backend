import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { POSE_BOUNDS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose and car from the join options and relays the profile picture", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pfp: "https://static.bloxity.io/img/pfps/3.png",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4 },
      loadout: { car: "comet", level: 7 },
    });
    const b = await colyseus.connectTo(room, { userId: "guest-b", pfp: "javascript:alert(1)" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed, p.car, p.level], [3, 0.5, -12, 4, "comet", 7]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.strictEqual(p.pfp, "https://static.bloxity.io/img/pfps/3.png");
    assert.strictEqual(room.state.players.get(b.sessionId)!.pfp, "", "only http(s) pictures are relayed");
  });

  it("bounds poses and the car id and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3 });
    a.send("loadout", { car: "Bad Id!", level: 1e12 });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.xy);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.car, "", "a malformed id is ignored");
    a.send("loadout", { car: "ember" });
    await sleep(100);
    assert.strictEqual((b.state as any).players.get(a.sessionId).car, "ember");
  });
});
