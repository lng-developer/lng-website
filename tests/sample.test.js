// tests/sample.test.js
// Smoke test to verify Jest setup works correctly

describe("Project Setup", () => {
    it("should have NODE_ENV defined or default", () => {
        // Just verify Jest can run
        expect(typeof process.env).toBe("object");
    });

    it("should correctly perform basic math", () => {
        expect(1 + 1).toBe(2);
    });

    it("should handle async operations", async () => {
        const result = await Promise.resolve("ok");
        expect(result).toBe("ok");
    });
});
