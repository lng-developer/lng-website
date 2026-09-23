const ExtensionTask = require("../models/extensionTask.model");
const { findPendingTasks } = require("./taskStatus.service");

jest.mock("../models/taskStatusEvent.model", () => ({}));
jest.mock("../models/autoConfig.model", () => ({}));
jest.mock("../models/extensionTask.model", () => ({ find: jest.fn() }));

test("findPendingTasks limits reconnect replay to fresh sent tasks", async () => {
  const sentAfter = new Date("2026-09-23T02:50:00.000Z");
  const lean = jest.fn().mockResolvedValue([]);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  ExtensionTask.find.mockReturnValue({ sort });

  await findPendingTasks({ shopId: "shop-1", machineId: "machine-1", statuses: ["sent"], sentAfter });

  expect(ExtensionTask.find).toHaveBeenCalledWith({
    shopId: "shop-1",
    machineId: "machine-1",
    status: { $in: ["sent"] },
    sentAt: { $gte: sentAfter },
  });
});
