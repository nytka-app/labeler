// Every gesture and button saves: each test acts through the feed and then checks the bodies the fake server
// received, never the UI's own idea of what it sent.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  ASK, CONTENT, DEVICE_TYPE, FEED, FLAGS, LANGUAGE, needsMore,
} from "../web/taxonomy.js";

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fake/reset");
  page.on("pageerror", (e) => { throw e; });
});

const posts = async (request) => (await (await request.get("/__fake/posts")).json()).filter((p) => p.body);

async function waitPosts(request, n) {
  try {
    await expect.poll(async () => (await posts(request)).length, { timeout: 15000 }).toBe(n);
  } catch (e) {
    console.log("POSTS", JSON.stringify((await posts(request)).map((p) => [p.itemId, p.body.skipped ? "skip" : p.body.answeredWith])));
    throw e;
  }
  return posts(request);
}

/** Opens a session. `undoMs=0` sends at once; the undo test keeps the real 4-s window. */
async function start(page, task, { undo = false } = {}) {
  await page.goto(undo ? "/" : "/?undoMs=0");
  await page.locator(`button[data-task=${task}]`).click();
  await movedFrom(page, -1, 0);
}

const at = (page, i) => page.locator(`.slide[data-index="${i}"][aria-current="true"]`);
const current = (page) => page.locator(`.slide[aria-current="true"]`);

async function index(page) {
  return Number(await current(page).getAttribute("data-index"));
}

/** Waits until the feed shows slide `to` (by default the one after `from`). */
async function movedFrom(page, from, to = from + 1) {
  await expect(at(page, to)).toBeVisible({ timeout: 10000 });
  // Wait for the smooth scroll to settle on the slide, as a person's next tap would.
  await page.waitForFunction((i) => {
    const f = document.getElementById("feed");
    const s = document.querySelector(`[data-index="${i}"]`);
    return f && s && Math.abs(s.getBoundingClientRect().top - f.getBoundingClientRect().top) < 2;
  }, to, { timeout: 10000 });
}

async function swipe(page, dir) {
  const i = await index(page);
  const box = await current(page).getByTestId("card").boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const dx = dir === "right" ? 160 : -160;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 4, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
  return i;
}

async function sheetPick(page, field, value) {
  await current(page).locator(`.sheet button[data-field=${field}][data-value=${value}]`).click();
}

/** Scrolls one screen, as a swipe up (next) or down (back) does. */
async function flick(page, dir) {
  const i = await index(page);
  const box = await current(page).getByTestId("card").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dir === "up" ? 900 : -900);
  await movedFrom(page, i, dir === "up" ? i + 1 : i - 1);
}

const value = (p, field) => (field === "source" ? p.body.source : p.body[field]);

// ---------- gestures, per task ----------

for (const [task, f] of Object.entries(FEED)) {
  test(`${task}: swipe right and left save the task's yes and no`, async ({ page, request }) => {
    await start(page, task);
    const expected = [];
    for (const which of ["yes", "no"]) {
      const s = f[which];
      const from = await swipe(page, which === "yes" ? "right" : "left");
      if (s.value) {
        expected.push({ v: s.value, how: "swipe" });
      } else {
        const pick = s.sheet.find((v) => !needsMore(f.ask, v));
        await sheetPick(page, f.ask, pick);
        expected.push({ v: pick, how: "sheet" });
      }
      await movedFrom(page, from);
    }
    const got = await waitPosts(request, 2);
    got.forEach((p, k) => {
      expect(value(p, f.ask)).toEqual(f.ask === "source" ? [expected[k].v] : expected[k].v);
      expect(p.body.answeredWith).toBe(expected[k].how);
      expect(p.body.skipped).toBe(false);
      expect(p.body.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof p.body.listenedMs).toBe("number");
    });
    expect(got[0].itemId).not.toBe(got[1].itemId);
  });

  test(`${task}: the rail's Yes and No save the same as the swipes`, async ({ page, request }) => {
    await start(page, task);
    for (const which of ["yes", "no"]) {
      const from = await index(page);
      await current(page).locator(`.rail [data-action=${which}]`).click();
      const s = f[which];
      if (!s.value) await sheetPick(page, f.ask, s.sheet.find((v) => !needsMore(f.ask, v)));
      await movedFrom(page, from);
    }
    const got = await waitPosts(request, 2);
    expect(got.map((p) => p.body.answeredWith)).toEqual([f.yes.value ? "button" : "sheet", f.no.value ? "button" : "sheet"]);
    expect(got.map((p) => value(p, f.ask))).toEqual(["yes", "no"].map((w) => {
      const v = f[w].value ?? f[w].sheet.find((x) => !needsMore(f.ask, x));
      return f.ask === "source" ? [v] : v;
    }));
  });

  test(`${task}: every value in the More sheet saves`, async ({ page, request }) => {
    await start(page, task);
    const values = ASK[f.ask].options.map((o) => o.value).filter((v) => !needsMore(f.ask, v));
    for (const v of values) {
      const from = await index(page);
      await current(page).locator(".rail [data-action=more]").click();
      await sheetPick(page, f.ask, v);
      await movedFrom(page, from);
    }
    const got = await waitPosts(request, values.length);
    expect(got.map((p) => value(p, f.ask))).toEqual(values.map((v) => (f.ask === "source" ? [v] : v)));
    expect(new Set(got.map((p) => p.itemId)).size).toBe(values.length);
    for (const p of got) expect(p.body.answeredWith).toBe("sheet");
  });
}

test("swipe up skips, swipe down goes back, and a second answer reaches the server for the same item", async ({ page, request }) => {
  await start(page, "voice");
  await flick(page, "up");
  await swipe(page, "right");
  await movedFrom(page, 1, 2);
  await flick(page, "down");
  await expect(current(page).getByTestId("saved-state")).toHaveText("Saved ✓");
  await swipe(page, "left");
  await movedFrom(page, 1, 2);
  const got = await waitPosts(request, 3);
  expect(got[0].body).toEqual({ clientId: expect.any(String), skipped: true });
  expect(got[1].body.source).toEqual(["me"]);
  expect(got[2].body.source).toEqual(["not_me"]);
  expect(got[2].itemId).toBe(got[1].itemId);
});

test("the rail's Skip skips", async ({ page, request }) => {
  await start(page, "quiet");
  await current(page).locator(".rail [data-action=skip]").click();
  await movedFrom(page, 0);
  const [p] = await waitPosts(request, 1);
  expect(p.body.skipped).toBe(true);
});

test("several: up to two sources are sent together", async ({ page, request }) => {
  await start(page, "device");
  await swipe(page, "left");
  await sheetPick(page, "source", "several");
  for (const v of ["me", "device", "live"]) await current(page).locator(`.sheet button[data-field=several][data-value=${v}]`).click();
  await current(page).locator(".sheet [data-action=send]").click();
  const [p] = await waitPosts(request, 1);
  expect(p.body.source).toEqual(["me", "device"]);
  expect(p.body.answeredWith).toBe("sheet");
});

test("wrong words: the corrected text is sent", async ({ page, request }) => {
  await start(page, "transcript");
  await swipe(page, "left");
  await sheetPick(page, "transcript", "wrong_words");
  await current(page).locator("textarea.correction").fill("Synthetic corrected words");
  await current(page).locator(".sheet [data-action=send]").click();
  const [p] = await waitPosts(request, 1);
  expect(p.body.transcript).toBe("wrong_words");
  expect(p.body.correction).toBe("Synthetic corrected words");
});

test("every optional detail in the More sheet saves: device type, sound, flags, language", async ({ page, request }) => {
  await start(page, "device");
  const n = DEVICE_TYPE.length;
  for (let i = 0; i < n; i++) {
    const from = await index(page);
    await current(page).locator(".rail [data-action=more]").click();
    const sheet = current(page).locator(".sheet");
    await sheet.locator(`button[data-field=deviceType][data-value=${DEVICE_TYPE[i].value}]`).click();
    await sheet.locator(`button[data-field=content][data-value=${CONTENT[i % CONTENT.length].value}]`).click();
    await sheet.locator(`button[data-field=flags][data-value=${FLAGS[i % FLAGS.length].value}]`).click();
    await sheet.locator(`button[data-field=flags][data-value=${FLAGS[(i + 1) % FLAGS.length].value}]`).click();
    await sheet.locator(`button[data-field=language][data-value=${LANGUAGE[i % LANGUAGE.length].value}]`).click();
    await sheetPick(page, "source", "device");
    await movedFrom(page, from);
  }
  const got = await waitPosts(request, n);
  got.forEach((p, i) => {
    expect(p.body.source).toEqual(["device"]);
    expect(p.body.deviceType).toBe(DEVICE_TYPE[i].value);
    expect(p.body.content).toBe(CONTENT[i % CONTENT.length].value);
    expect(p.body.flags).toEqual([FLAGS[i % FLAGS.length].value, FLAGS[(i + 1) % FLAGS.length].value]);
    expect(p.body.language).toBe(LANGUAGE[i % LANGUAGE.length].value);
  });
});

test("keyboard: arrows answer and move, digits answer, J skips", async ({ page, request }, info) => {
  test.skip(info.project.name === "phone", "keyboard is the desktop path");
  await start(page, "voice");
  await page.keyboard.press("ArrowRight");
  await movedFrom(page, 0);
  await page.keyboard.press("ArrowLeft");
  await movedFrom(page, 1);
  for (const [k, i] of [["2", 2], ["3", 3], ["4", 4], ["5", 5]]) { await page.keyboard.press(k); await movedFrom(page, i); }
  await page.keyboard.press("j");
  await movedFrom(page, 6);
  await page.keyboard.press("ArrowUp");
  await movedFrom(page, 7, 6);
  const got = await waitPosts(request, 7);
  expect(got.slice(0, 6).map((p) => p.body.source[0])).toEqual(["me", "not_me", "live", "device", "call", "none"]);
  expect(got.slice(0, 6).map((p) => p.body.answeredWith)).toEqual(["key", "key", "key", "key", "key", "key"]);
  expect(got[6].body.skipped).toBe(true);
});

// ---------- the model's guess, undo, the end ----------

test("the model's guess is hidden until after the answer", async ({ page }) => {
  await start(page, "device");
  await expect(current(page)).not.toContainText("model said");
  await expect(current(page)).not.toContainText("0.40");
  await swipe(page, "right");
  await expect(page.locator("#toast")).toContainText("model said");
});

test("undo inside the window sends nothing; without undo the answer is sent after it", async ({ page, request }) => {
  await start(page, "voice", { undo: true });
  await swipe(page, "right");
  await movedFrom(page, 0);
  await page.locator("#toast button", { hasText: "Undo" }).click();
  await movedFrom(page, 1, 0);
  await page.waitForTimeout(5000);
  expect(await posts(request)).toHaveLength(0);
  await swipe(page, "left");
  await page.waitForTimeout(1000);
  expect(await posts(request)).toHaveLength(0); // still inside the window
  const [p] = await waitPosts(request, 1);
  expect(p.body.source).toEqual(["not_me"]);
});

test("the feed ends at the goal with an honest summary", async ({ page, request }) => {
  await start(page, "device");
  for (let i = 0; i < 8; i++) {
    await swipe(page, i % 2 ? "right" : "left");
    if (i % 2 === 0) await sheetPick(page, "source", "live");
    await movedFrom(page, i);
  }
  await waitPosts(request, 8);
  const end = page.locator("#end-slide[aria-current=true]");
  await expect(end).toContainText("Session done");
  await expect(end).toContainText("8 answered, 0 skipped.");
  await expect(end).toContainText("disagreed with the model");
  await expect(end).toContainText("Device audio: 0 → 8 of 100");
  await expect(page.locator("#done-pending")).toHaveText("Every answer is saved on the server.");
  await expect(end.locator(".day.on")).toHaveCount(1);
  expect(await page.locator(".slide").count()).toBe(9); // 8 clips and the end: nothing after the goal
});

test("mixed: runs of one task, each answer saved under its own task's question", async ({ page, request }) => {
  await start(page, "mixed");
  const tasks = await page.locator(".slide[data-task]").evaluateAll((s) => s.map((x) => x.dataset.task));
  expect(tasks.slice(0, 8)).toEqual(["device", "device", "device", "device", "voice", "voice", "voice", "voice"]);
  for (let i = 0; i < 6; i++) { await swipe(page, "right"); await movedFrom(page, i); }
  const got = await waitPosts(request, 6);
  expect(got.slice(0, 4).map((p) => p.body.source)).toEqual([["device"], ["device"], ["device"], ["device"]]);
  expect(got.slice(4).map((p) => p.body.source)).toEqual([["me"], ["me"]]);
});

test("a hidden tab pauses the clip and it stays paused", async ({ page }) => {
  await start(page, "voice");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(current(page)).not.toHaveClass(/playing/);
});

// ---------- delivery ----------

test("server errors: retried until saved; a 400 shows as not saved", async ({ page, request }) => {
  await request.post("/__fake/fail", { data: { status: 500, times: 2 } });
  await start(page, "voice");
  await swipe(page, "right");
  await movedFrom(page, 0);
  await flick(page, "down");
  await expect(current(page).getByTestId("saved-state")).toHaveText("Saved ✓", { timeout: 25000 });
  expect((await posts(request)).length).toBe(3);

  await request.post("/__fake/fail", { data: { status: 400, times: 1 } });
  await flick(page, "up");
  await swipe(page, "left");
  await movedFrom(page, 1, 2);
  await flick(page, "down");
  await expect(current(page).getByTestId("saved-state")).toContainText("Not saved");
});

test("offline: answers wait in the outbox, survive a reload, then send", async ({ page, request, context }) => {
  await start(page, "quiet");
  await context.setOffline(true);
  await swipe(page, "right");
  await movedFrom(page, 0);
  await swipe(page, "left");
  await sheetPick(page, "transcript", "made_up");
  await movedFrom(page, 1);
  await expect(page.locator("#status")).toContainText("2 unsent");
  expect((await posts(request)).length).toBe(0);
  await page.close();

  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto("/");
  // At least once: a request that reached the server while the browser flipped back online may be sent again
  // with the same clientId, which the server treats as the same answer.
  await expect.poll(async () => new Set((await posts(request)).map((p) => p.body.clientId)).size, { timeout: 15000 }).toBe(2);
  const once = [...new Map((await posts(request)).map((p) => [p.body.clientId, p])).values()];
  expect(once.map((p) => p.body.transcript)).toEqual(["right", "made_up"]);
  await expect(again.locator("#status")).toHaveText("");
});

test("confirm my voice: only the ticked lines are sent", async ({ page, request }) => {
  await start(page, "voice");
  for (let i = 0; i < 3; i++) { await swipe(page, "right"); await movedFrom(page, i); }
  await swipe(page, "left");
  await waitPosts(request, 4);
  await page.goto("/?undoMs=0");
  await page.getByRole("button", { name: "Review" }).click();
  const boxes = page.locator(".confirm-list input");
  await expect(boxes).toHaveCount(3);
  const untick = await boxes.nth(1).getAttribute("data-label-id");
  await boxes.nth(1).uncheck();
  await page.locator("button[data-action=confirm-voice]").click();
  await expect(page.locator("#voice-learned")).toHaveText("2 lines taught your voiceprint.");
  const confirm = (await (await request.get("/__fake/posts")).json()).find((p) => p.confirm).confirm;
  expect(confirm.labelIds).toHaveLength(2);
  expect(confirm.labelIds).not.toContain(Number(untick));
});

async function violations(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  return (await new AxeBuilder({ page }).exclude(".slide:not([aria-current])").analyze()).violations
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("no accessibility violations on the task list, a clip and its sheet", async ({ page }) => {
  await page.goto("/?undoMs=0");
  await expect(page.locator("button[data-task=device]")).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.locator("button[data-task=device]").click();
  await expect(at(page, 0)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await current(page).locator(".rail [data-action=more]").click();
  expect(await violations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
