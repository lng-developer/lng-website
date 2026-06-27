describe("logger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("does not write debug logs in production unless enabled", () => {
    process.env.NODE_ENV = "production";
    delete process.env.LOG_LEVEL;

    const logger = require("../logger");
    logger.debug("hot path detail");

    expect(console.log).not.toHaveBeenCalled();
  });

  test("writes errors to stderr", () => {
    process.env.NODE_ENV = "production";

    const logger = require("../logger");
    logger.error("cost compute failed");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[ERROR] cost compute failed"));
  });
});
