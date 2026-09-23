const { nextFixedRunAt, nextRunAt } = require("./autoConfig.controller");

test("supports intervals longer than one hour", () => {
  expect(nextRunAt(240, new Date("2026-09-21T01:10:00.000Z")).toISOString())
    .toBe("2026-09-21T04:00:00.000Z");
});

test("uses the next configured Vietnam hour", () => {
  expect(nextFixedRunAt([5, 10, 15, 20], new Date("2026-09-21T02:30:00.000Z")).toISOString())
    .toBe("2026-09-21T03:00:00.000Z");
});
