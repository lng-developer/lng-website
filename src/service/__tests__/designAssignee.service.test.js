jest.mock("../../models", () => ({
  user: {
    findById: jest.fn(),
  },
  role: {
    findById: jest.fn(),
  },
}));

const db = require("../../models");
const { getAssignableDesignUser } = require("../designAssignee.service");

function mockFindByIdLean(findByIdMock, row) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(row),
  };
  findByIdMock.mockReturnValue(chain);
  return chain;
}

describe("designAssignee.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns a user when role is Designer", async () => {
    const user = {
      _id: "111111111111111111111111",
      full_name: "Designer",
      email: "designer@example.com",
      role_id: "222222222222222222222222",
    };

    mockFindByIdLean(db.user.findById, user);
    mockFindByIdLean(db.role.findById, { name: "Designer" });

    await expect(getAssignableDesignUser(user._id)).resolves.toEqual({
      user,
      role: { name: "Designer" },
      roleName: "designer",
    });
  });

  test("throws 400 when id is invalid", async () => {
    await expect(
      getAssignableDesignUser("bad-id", { invalidMessage: "Invalid scaleUserId" })
    ).rejects.toMatchObject({
      message: "Invalid scaleUserId",
      statusCode: 400,
    });
    expect(db.user.findById).not.toHaveBeenCalled();
  });

  test("throws 400 when role is not assignable for design work", async () => {
    const user = {
      _id: "111111111111111111111111",
      role_id: "222222222222222222222222",
    };

    mockFindByIdLean(db.user.findById, user);
    mockFindByIdLean(db.role.findById, { name: "Customer Service" });

    await expect(getAssignableDesignUser(user._id)).rejects.toMatchObject({
      message: "Selected user must be Designer or Design Leader",
      statusCode: 400,
      debug: {
        userId: user._id,
        role_id: user.role_id,
        role_name: "Customer Service",
      },
    });
  });
});
