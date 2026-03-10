/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/src", "<rootDir>/tests"],
    testMatch: [
        "**/__tests__/**/*.test.js",
        "**/*.test.js",
    ],
    collectCoverageFrom: [
        "src/**/*.js",
        "!src/**/index.js",
        "!src/models/**",
        "!node_modules/**",
    ],
    coverageDirectory: "coverage",
    coverageReporters: ["text", "lcov", "clover"],
    // Timeout cao hơn cho integration tests
    testTimeout: 30000,
    // Không chạy tests song song (tránh conflict DB)
    maxWorkers: 1,
    // Setup files
    // globalSetup: "./tests/setup.js",
};
