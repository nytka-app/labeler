import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:8788", trace: "retain-on-failure" },
  webServer: { command: "node test/fake-api.mjs 8788", url: "http://127.0.0.1:8788/api/v1/labeling/tasks", reuseExistingServer: false },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
