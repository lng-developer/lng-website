const { installConsoleGuard } = require("../consoleGuard");

function makeConsole() {
  return {
    log: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe("consoleGuard", () => {
  test("suppresses stdout-style logs in production by default", () => {
    const target = makeConsole();
    const original = { ...target };
    installConsoleGuard(target, { NODE_ENV: "production" });

    target.log("noise");
    target.info("noise");
    target.debug("noise");
    target.warn("keep");
    target.error("keep");

    expect(original.log).not.toHaveBeenCalled();
    expect(original.info).not.toHaveBeenCalled();
    expect(original.debug).not.toHaveBeenCalled();
    expect(original.warn).toHaveBeenCalledWith("keep");
    expect(original.error).toHaveBeenCalledWith("keep");
  });

  test("allows stdout-style logs when LOG_LEVEL enables them", () => {
    const target = makeConsole();
    const original = { ...target };
    installConsoleGuard(target, { NODE_ENV: "production", LOG_LEVEL: "debug" });

    target.log("show");
    target.info("show");
    target.debug("show");

    expect(original.log).toHaveBeenCalledWith("show");
    expect(original.info).toHaveBeenCalledWith("show");
    expect(original.debug).toHaveBeenCalledWith("show");
  });
});
