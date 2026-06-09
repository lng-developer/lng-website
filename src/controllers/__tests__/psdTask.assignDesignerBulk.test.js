jest.mock("../../models", () => ({
  PsdTask: {
    find: jest.fn(),
  },
  listing: {},
  user: {
    findById: jest.fn(),
  },
  role: {
    findById: jest.fn(),
  },
}));

jest.mock("../../service/psdTask/psdTask.js", () => ({
  changeStatus: jest.fn(),
  uploadFile: jest.fn(),
}));

jest.mock("../../utils/wasabi.js", () => ({
  uploadBufferToWasabi: jest.fn(),
}));

jest.mock("../../service/pointsService.js", () => ({
  addPointsFromTask: jest.fn(),
  addPenaltyFromTask: jest.fn(),
}));

const db = require("../../models");
const PsdTaskController = require("../psdTask.controller");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function mockFindByIdLean(findByIdMock, row) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(row),
  };
  findByIdMock.mockReturnValue(chain);
  return chain;
}

function makeTask(overrides = {}) {
  return {
    _id: "333333333333333333333333",
    status: "New",
    designer: null,
    difficulty: "Easy",
    history: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("PsdTaskController.assignDesignerBulk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 400 when taskIds is missing", async () => {
    const req = {
      body: {
        designer: "111111111111111111111111",
      },
    };
    const res = makeRes();

    await PsdTaskController.assignDesignerBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "taskIds must be a non-empty array",
    });
    expect(db.PsdTask.find).not.toHaveBeenCalled();
  });

  test("assigns selected PSD tasks to a designer", async () => {
    const designer = {
      _id: "111111111111111111111111",
      full_name: "PSD Designer",
      email: "designer@example.com",
      role_id: "222222222222222222222222",
    };
    const task1 = makeTask({ _id: "333333333333333333333333", status: "New" });
    const task2 = makeTask({
      _id: "444444444444444444444444",
      status: "Requested",
    });

    mockFindByIdLean(db.user.findById, designer);
    mockFindByIdLean(db.role.findById, { name: "Designer" });
    db.PsdTask.find.mockResolvedValue([task1, task2]);

    const req = {
      body: {
        taskIds: ["333333333333333333333333", "444444444444444444444444"],
        designer: designer._id,
        difficulty: "Normal",
      },
      user: { userId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    };
    const res = makeRes();

    await PsdTaskController.assignDesignerBulk(req, res);

    expect(db.PsdTask.find).toHaveBeenCalledWith({
      _id: {
        $in: ["333333333333333333333333", "444444444444444444444444"],
      },
    });
    expect(task1.status).toBe("Assigned");
    expect(task2.status).toBe("Assigned");
    expect(task1.designer).toBe(designer._id);
    expect(task2.designer).toBe(designer._id);
    expect(task1.difficulty).toBe("Normal");
    expect(task1.history[0]).toEqual(
      expect.objectContaining({
        by: "aaaaaaaaaaaaaaaaaaaaaaaa",
        from: "New",
        to: "Assigned",
        action: "Assign designer bulk",
      })
    );
    expect(task1.save).toHaveBeenCalledTimes(1);
    expect(task2.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Bulk PSD task assignment completed",
        total: 2,
        success: 2,
        failed: 0,
      })
    );
  });

  test("skips invalid, non-assignable, already assigned, and missing tasks", async () => {
    const designer = {
      _id: "111111111111111111111111",
      full_name: "PSD Designer",
      email: "designer@example.com",
      role_id: "222222222222222222222222",
    };
    const inProgressTask = makeTask({
      _id: "333333333333333333333333",
      status: "In Progress",
    });
    const assignedTask = makeTask({
      _id: "444444444444444444444444",
      status: "Assigned",
      designer: "999999999999999999999999",
    });

    mockFindByIdLean(db.user.findById, designer);
    mockFindByIdLean(db.role.findById, { name: "Design Leader" });
    db.PsdTask.find.mockResolvedValue([inProgressTask, assignedTask]);

    const req = {
      body: {
        taskIds: [
          "not-object-id",
          "333333333333333333333333",
          "444444444444444444444444",
          "555555555555555555555555",
        ],
        designer: designer._id,
      },
      user: { userId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    };
    const res = makeRes();

    await PsdTaskController.assignDesignerBulk(req, res);

    expect(inProgressTask.save).not.toHaveBeenCalled();
    expect(assignedTask.save).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      message: "Bulk PSD task assignment completed",
      total: 4,
      success: 0,
      failed: 4,
      results: [
        expect.objectContaining({
          taskId: "not-object-id",
          status: "failed",
          error: "Invalid taskId",
        }),
        expect.objectContaining({
          taskId: "333333333333333333333333",
          status: "failed",
          error: "Task status cannot be assigned",
        }),
        expect.objectContaining({
          taskId: "444444444444444444444444",
          status: "failed",
          error: "Task already assigned",
        }),
        expect.objectContaining({
          taskId: "555555555555555555555555",
          status: "failed",
          error: "Task not found",
        }),
      ],
    });
  });

  test("rejects target user when role is not designer or design leader", async () => {
    const designer = {
      _id: "111111111111111111111111",
      full_name: "Customer Service",
      email: "cs@example.com",
      role_id: "222222222222222222222222",
    };

    mockFindByIdLean(db.user.findById, designer);
    mockFindByIdLean(db.role.findById, { name: "Customer Service" });

    const req = {
      body: {
        taskIds: ["333333333333333333333333"],
        designer: designer._id,
      },
    };
    const res = makeRes();

    await PsdTaskController.assignDesignerBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Bulk PSD task assignment failed",
        error: "Selected user must be Designer or Design Leader",
      })
    );
    expect(db.PsdTask.find).not.toHaveBeenCalled();
  });
});
