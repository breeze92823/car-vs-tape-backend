import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { PlayClock } from "../src/playtime.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("free boost chest", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    process.env.PLAY_REWARD_MS = "300";
    await colyseus.cleanup();
  });
  afterEach(() => {
    delete process.env.PLAY_REWARD_MS;
    __setPlayersForTest(null);
  });

  it("counts only active time, caps at the goal and restarts after a claim", () => {
    const c = new PlayClock(0, true, 300, 1000);
    assert.strictEqual(c.ms(1100), 100);
    c.setActive(false, 1100);
    assert.strictEqual(c.ms(5000), 100, "a hidden tab does not count");
    c.setActive(true, 5000);
    assert.strictEqual(c.ms(9000), 300, "capped at the goal");
    assert.ok(c.take(9000));
    assert.strictEqual(c.ms(9000), 0);
    assert.ok(!c.take(9050));
  });

  it("refuses guests and early claims, then opens after the hour and saves the count", async () => {
    const fake = fakePlayers([{ _id: "u1", playMs: 100, chestClaims: 2, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});

    const guest = await colyseus.connectTo(room, { userId: "guest-zz" });
    const guestResults: any[] = [];
    guest.onMessage("chestResult", (m: any) => guestResults.push(m));

    const c = await colyseus.connectTo(room, { userId: "u1" });
    const results: any[] = [];
    let play: any = null;
    c.onMessage("progress", () => {});
    c.onMessage("playtime", (m: any) => (play = m));
    c.onMessage("chestResult", (m: any) => results.push(m));
    fake.release();
    await sleep(60);

    guest.send("claimChest", {});
    assert.strictEqual(play?.signedIn, true);
    assert.ok(play.playMs >= 100, "the saved count carries over");
    assert.strictEqual(play.needMs, 300);
    assert.strictEqual(play.claims, 2);

    c.send("claimChest", {});
    await sleep(60);
    assert.strictEqual(guestResults[0]?.reason, "signin");
    assert.strictEqual(guestResults[0]?.signedIn, false);
    assert.strictEqual(results[0]?.ok, false);
    assert.strictEqual(results[0]?.reason, "early");

    await sleep(250);
    c.send("claimChest", {});
    c.send("claimChest", {});
    await sleep(60);
    assert.strictEqual(results[1]?.ok, true);
    assert.strictEqual(results[1]?.claims, 3);
    assert.strictEqual(results[2]?.ok, false, "one chest per hour, even when asked twice");
    assert.strictEqual(fake.docs.get("u1")?.chestClaims, 3);
    assert.ok((fake.docs.get("u1")?.playMs ?? 1) < 300);
  });

  it("stops the clock while the tab is hidden and never takes playMs from a save", async () => {
    const fake = fakePlayers([{ _id: "u2", version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u2" });
    c.onMessage("progress", () => {});
    c.onMessage("playtime", () => {});
    c.send("playActive", { active: false });
    fake.release();
    await sleep(350);
    c.send("saveProgress", { power: 1, playMs: 1e9 });
    await sleep(60);
    assert.ok((fake.docs.get("u2")?.playMs ?? 0) < 50, "hidden time and client values don't count");
  });
});

describe("free car", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    process.env.CAR_GIFT_MS = "200";
    await colyseus.cleanup();
  });
  afterEach(() => {
    delete process.env.CAR_GIFT_MS;
    __setPlayersForTest(null);
  });

  it("gives each car once after the play goal, grows the goal and keeps the car owned", async () => {
    const fake = fakePlayers([{ _id: "u5", owned: ["pebble"], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u5" });
    const results: any[] = [];
    let play: any = null;
    c.onMessage("progress", () => {});
    c.onMessage("playtime", (m: any) => (play = m));
    c.onMessage("carResult", (m: any) => results.push(m));
    fake.release();
    await sleep(60);
    assert.strictEqual(play?.car?.needMs, 200);

    c.send("claimCar", { car: "bubble" });
    c.send("claimCar", { car: "../bad" });
    await sleep(60);
    assert.strictEqual(results[0]?.reason, "early");
    assert.strictEqual(results[1]?.reason, "bad");

    await sleep(200);
    c.send("claimCar", { car: "bubble" });
    c.send("claimCar", { car: "sprout" });
    await sleep(60);
    assert.strictEqual(results[2]?.ok, true);
    assert.strictEqual(results[2]?.carId, "bubble");
    assert.strictEqual(results[3]?.reason, "early", "one car per goal");
    const doc = fake.docs.get("u5")! as any;
    assert.deepStrictEqual(doc.owned, ["pebble", "bubble"]);
    assert.deepStrictEqual(doc.giftedCars, ["bubble"]);
    assert.strictEqual(doc.carGifts, 1);

    // A stale save drops the gift: the next load gives it back, and the goal is now longer.
    c.send("saveProgress", { owned: ["pebble"] });
    await sleep(60);
    const fake2 = fakePlayers([...fake.docs.values()]);
    __setPlayersForTest(fake2);
    const c2 = await colyseus.connectTo(room, { userId: "u5" });
    let got: any = null;
    let play2: any = null;
    c2.onMessage("progress", (m: any) => (got = m));
    c2.onMessage("playtime", (m: any) => (play2 = m));
    fake2.release();
    await sleep(100);
    assert.deepStrictEqual(got?.owned, ["pebble", "bubble"]);
    assert.strictEqual(play2?.car?.needMs, 300);
    assert.deepStrictEqual(play2?.car?.gifted, ["bubble"]);
  });
});
