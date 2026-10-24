// Phone-sized README screenshots from the fake API (synthetic lines, no real audio): node test/screenshots.mjs
import { spawn } from "node:child_process";
import { chromium, devices } from "@playwright/test";

const port = 8790;
const fake = spawn("node", ["test/fake-api.mjs", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch();
try {
  for (const scheme of ["dark", "light"]) {
    const page = await browser.newPage({ ...devices["Pixel 7"], colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${port}/?undoMs=0`);
    await page.locator("button[data-task=device]").waitFor();
    await page.screenshot({ path: `docs/img/tasks-${scheme}.png` });
    await page.locator("button[data-task=device]").click();
    await page.locator('.slide[aria-current="true"]').waitFor();
    await page.waitForTimeout(1200); // let the waveform fill a little
    await page.screenshot({ path: `docs/img/card-${scheme}.png` });
    await page.locator('.slide[aria-current="true"] .rail [data-action=no]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `docs/img/sheet-${scheme}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  fake.kill();
}
