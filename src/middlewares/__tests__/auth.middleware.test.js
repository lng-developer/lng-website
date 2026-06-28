const jwt = require("jsonwebtoken");

let mockUser;

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

jest.mock("../../models", () => ({
  user: {
    findById: jest.fn(() => ({
      select: jest.fn().mockResolvedValue(mockUser),
    })),
  },
}));

const { authenticateToken } = require("../auth.middleware");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function runWithUser(user) {
  mockUser = user;
  jwt.verify.mockReturnValue({
    userId: "507f1f77bcf86cd799439011",
    role: "Admin",
    iat: Math.floor(Date.now() / 1000),
  });

  const req = { headers: { authorization: "Bearer token" } };
  const res = makeRes();
  const next = jest.fn();

  await authenticateToken(req, res, next);

  expect(next).toHaveBeenCalled();
  return req.user;
}

describe("authenticateToken actor name", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = null;
  });

  test("uses full_name before other display fields", async () => {
    const user = await runWithUser({
      full_name: "Full Name",
      name: "Name",
      username: "username",
      email: "email@example.com",
    });

    expect(user.name).toBe("Full Name");
  });

  test("falls back to name, username, then email", async () => {
    await expect(runWithUser({ name: "Name" })).resolves.toMatchObject({ name: "Name" });
    await expect(runWithUser({ username: "username" })).resolves.toMatchObject({ name: "username" });
    await expect(runWithUser({ email: "email@example.com" })).resolves.toMatchObject({ name: "email@example.com" });
  });
});
