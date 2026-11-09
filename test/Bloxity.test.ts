import assert from "assert";

import { __setFetchForTest, flushReports, queueReport, verifyAdReward } from "../src/bloxity.js";

describe("bloxity", () => {
  const calls: { url: string; body: any; auth?: string }[] = [];
  let answer: any = { valid: true };
  beforeEach(() => {
    calls.length = 0;
    __setFetchForTest((async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { json: async () => answer } as Response;
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    __setFetchForTest(null);
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.BLOXITY_GAME_ID;
    delete process.env.BLOXITY_API_URL;
  });

  it("reports nothing without the hosting credentials", async () => {
    queueReport("u1", { power: 5 });
    await flushReports();
    assert.strictEqual(calls.length, 0);
  });

  it("reports leaderboard scores and bounded profile stats for Boxity accounts only", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "tok";
    process.env.BLOXITY_GAME_ID = "car-vs-tape";
    process.env.BLOXITY_API_URL = "https://api.example.test";
    queueReport("u1", { power: 1500, wins: 20, rebirths: 2, level: 4, bestTape: 2, totalWins: 3e12 });
    queueReport("guest-x", { power: 9 });
    queueReport("dev-x", { power: 9 });
    await flushReports();
    const lb = calls.find((c) => c.url.endsWith("/v1/leaderboards/hosted/car-vs-tape/report"))!;
    const st = calls.find((c) => c.url.endsWith("/v1/games/car-vs-tape/stats"))!;
    assert.strictEqual(lb.auth, "Bearer tok");
    assert.deepStrictEqual(lb.body.scores, [
      { board: "power", userId: "legion_u1", score: 1500 },
      { board: "wins", userId: "legion_u1", score: 20 },
      { board: "rebirths", userId: "legion_u1", score: 2 },
    ]);
    assert.strictEqual(st.body.players.length, 1);
    assert.deepStrictEqual(st.body.players[0].values, { level: 4, rebirths: 2, tapes_snapped: 3, wins: 20, power: 1500 }, "total wins above the currency limit is dropped");
  });

  it("accepts only a valid ad reward token", async () => {
    process.env.BLOXITY_GAME_ID = "car-vs-tape";
    assert.strictEqual(await verifyAdReward("abc"), true);
    assert.strictEqual(calls[0].body.gameSlug, "car-vs-tape");
    answer = { valid: false, reason: "unknown" };
    assert.strictEqual(await verifyAdReward("abc"), false);
    assert.strictEqual(await verifyAdReward(""), false);
    assert.strictEqual(await verifyAdReward(42), false);
    answer = { valid: true };
  });
});
