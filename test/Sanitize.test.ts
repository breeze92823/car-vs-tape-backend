import assert from "assert";

import { CURRENCY_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ power: 1e40, wins: -5, totalWins: NaN, rebirths: 3.7, level: 0, autoDrive: "yes", hack: "x" })!;
    assert.strictEqual(out.power, CURRENCY_MAX);
    assert.strictEqual(out.wins, 0);
    assert.strictEqual(out.totalWins, undefined);
    assert.strictEqual(out.rebirths, 3);
    assert.strictEqual(out.level, 1);
    assert.strictEqual(out.autoDrive, undefined);
    assert.ok(!("hack" in out));
  });

  it("keeps well-formed car ids, always owns the default and only equips an owned car", () => {
    const out = sanitizeProgress({ owned: ["comet", "comet", "Bad Id!", 7], car: "comet" })!;
    assert.deepStrictEqual(out.owned, ["pebble", "comet"]);
    assert.strictEqual(out.car, "comet");
    assert.strictEqual(sanitizeProgress({ owned: ["comet"], car: "ember" })!.car, undefined);
  });

  it("bounds the best tape and the boost clocks", () => {
    assert.strictEqual(sanitizeProgress({ bestTape: -9 })!.bestTape, -1);
    assert.strictEqual(sanitizeProgress({ bestTape: 4.8 })!.bestTape, 4);
    const out = sanitizeProgress({ boostUntil: 1e18, boostReadyAt: Date.now() })!;
    assert.ok(out.boostUntil! < Date.now() + 25 * 3600 * 1000);
    assert.ok(out.boostReadyAt! <= Date.now() + 1000);
  });
});
