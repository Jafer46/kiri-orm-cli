// Plain object rather than defineConfig() so this file needs nothing installed to load.
export default {
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    // Each integration test spawns real `orm` processes (~0.2-0.5s each to start).
    testTimeout: 60000,
  },
};
