// Every button saves: each test taps through the UI and then checks the bodies the fake server received,
// never the UI's own idea of what it sent.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  CONTENT, DEVICE_TYPE, FLAGS, LANGUAGE, OVERLAP, SOURCE, TRANSCRIPT,
} from "../web/taxonomy.js";

test.beforeEach(async ({ request, page }) => {
  await request.post("/__fake/reset");
  page.on("pageerror", (e) => { throw e; });
});

async function posts(request) {
  return (await request.get("/__fake/posts")).json();
}

async function start(page, task) {
  await page.goto("/");
  await page.locator(`button[data-task=${task}]`).click();
  await expect(page.locator(".session")).toBeVisible();
}

const tap = (page, field, value) => page.locator(`.session button[data-field=${field}][data-value=${value}]`).click();

async function waitPosts(request, n) {
  await expect.poll(async () => (await posts(request)).length, { timeout: 10000 }).toBe(n);
  return posts(request);
}

const direct = (options, ...needMore) => options.map((o) => o.value).filter((v) => !needMore.includes(v));

for (const [task, field, values] of [
  ["device", "source", direct(SOURCE, "several")],
  ["voice", "source", direct(SOURCE, "several")],
  ["quiet", "transcript", direct(TRANSCRIPT, "wrong_words")],
  ["transcript", "transcript", direct(TRANSCRIPT, "wrong_words")],
  ["overlap", "overlap", direct(OVERLAP)],
]) {
  test(`${task}: every ${field} button saves its value`, async ({ page, request }) => {
    await start(page, task);
    for (const v of values) await tap(page, field, v);
    const got = await waitPosts(request, values.length);
    expect(got.map((p) => p.body[field])).toEqual(values.map((v) => (field === "source" ? [v] : v)));
    for (const p of got) {
      expect(p.body.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.body.skipped).toBe(false);
      expect(typeof p.body.listenedMs).toBe("number");
    }
    expect(new Set(got.map((p) => p.itemId)).size).toBe(values.length);
    expect(new Set(got.map((p) => p.body.clientId)).size).toBe(values.length);
  });
}

test("several: up to two sources are sent together", async ({ page, request }) => {
  await start(page, "device");
  await tap(page, "source", "several");
  await tap(page, "several", "me");
  await tap(page, "several", "device");
  await tap(page, "several", "live"); // a third is ignored
  await page.locator("button[data-action=send]").click();
  const [p] = await waitPosts(request, 1);
  expect(p.body.source).toEqual(["me", "device"]);
});

test("wrong words: the corrected text is sent", async ({ page, request }) => {
  await start(page, "transcript");
  await tap(page, "transcript", "wrong_words");
  await page.locator("#correction").fill("Synthetic corrected words");
  await page.locator("button[data-action=send]").click();
  const [p] = await waitPosts(request, 1);
  expect(p.body.transcript).toBe("wrong_words");
  expect(p.body.correction).toBe("Synthetic corrected words");
});

test("every optional button saves: device type, sound, flags, language", async ({ page, request }) => {
  await start(page, "device");
  await page.locator("details.optional summary").click();
  const n = DEVICE_TYPE.length;
  for (let i = 0; i < n; i++) {
    await tap(page, "deviceType", DEVICE_TYPE[i].value);
    await tap(page, "content", CONTENT[i % CONTENT.length].value);
    await tap(page, "flags", FLAGS[i % FLAGS.length].value);
    await tap(page, "flags", FLAGS[(i + 1) % FLAGS.length].value);
    await tap(page, "language", LANGUAGE[i % LANGUAGE.length].value);
    await tap(page, "source", "device");
  }
  const got = await waitPosts(request, n);
  got.forEach((p, i) => {
    expect(p.body.source).toEqual(["device"]);
    expect(p.body.deviceType).toBe(DEVICE_TYPE[i].value);
    expect(p.body.content).toBe(CONTENT[i % CONTENT.length].value);
    expect(p.body.flags).toEqual([FLAGS[i % FLAGS.length].value, FLAGS[(i + 1) % FLAGS.length].value]);
    expect(p.body.language).toBe(LANGUAGE[i % LANGUAGE.length].value);
  });
  // A second tap on an optional choice clears it.
  await tap(page, "content", "music");
  await tap(page, "content", "music");
  await tap(page, "source", "live");
  const last = (await waitPosts(request, n + 1)).at(-1);
  expect(last.body.content).toBeUndefined();
  expect(last.body.deviceType).toBeUndefined();
});

test("a prefilled language is a guess and is not sent unless touched", async ({ page, request }) => {
  await start(page, "voice");
  await tap(page, "source", "me");
  const [p] = await waitPosts(request, 1);
  expect(p.body.language).toBeUndefined();
});

test("keyboard: digits answer, S skips", async ({ page, request }, info) => {
  test.skip(info.project.name === "phone", "keyboard is the desktop path");
  await start(page, "voice");
  for (const k of ["1", "2", "3", "4", "5", "6"]) await page.keyboard.press(k);
  await page.keyboard.press("s");
  const got = await waitPosts(request, 7);
  expect(got.slice(0, 6).map((p) => p.body.source[0])).toEqual(["me", "live", "device", "call", "none", "cant_tell"]);
  expect(got[6].body).toEqual({ clientId: expect.any(String), skipped: true });
});

test("skip, then back and answer again: both reach the server, the tick shows saved", async ({ page, request }) => {
  await start(page, "overlap");
  await page.getByRole("button", { name: "Skip" }).click();
  await tap(page, "overlap", "two");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("saved-state")).toHaveText("Saved ✓");
  await tap(page, "overlap", "three_plus");
  const got = await waitPosts(request, 3);
  expect(got[0].body.skipped).toBe(true);
  expect(got[1].body.overlap).toBe("two");
  expect(got[2].body.overlap).toBe("three_plus");
  expect(got[2].itemId).toBe(got[1].itemId);
});

test("server errors: retried until saved; a 400 shows as not saved", async ({ page, request }) => {
  await request.post("/__fake/fail", { data: { status: 500, times: 2 } });
  await start(page, "device");
  await tap(page, "source", "live");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("saved-state")).toHaveText("Saved ✓", { timeout: 25000 });
  expect((await posts(request)).length).toBe(3);

  await request.post("/__fake/fail", { data: { status: 400, times: 1 } });
  await tap(page, "source", "call");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("saved-state")).toHaveText("Not saved");
});

test("offline: answers wait in the outbox, survive a reload, then send", async ({ page, request, context }) => {
  await start(page, "quiet");
  await context.setOffline(true);
  await tap(page, "transcript", "made_up");
  await tap(page, "transcript", "cant_hear");
  await expect(page.locator("#status")).toContainText("2 unsent");
  expect((await posts(request)).length).toBe(0);
  await page.close();

  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto("/");
  // Delivery is at least once: a request that reached the server while the browser was still flipping back
  // online may be sent again with the same clientId, which the server treats as the same answer.
  await expect.poll(async () => new Set((await posts(request)).map((p) => p.body.clientId)).size, { timeout: 10000 }).toBe(2);
  const once = [...new Map((await posts(request)).map((p) => [p.body.clientId, p])).values()];
  expect(once.map((p) => p.body.transcript)).toEqual(["made_up", "cant_hear"]);
  const tasks = (await (await request.get("/api/v1/labeling/tasks")).json()).tasks;
  expect(tasks.find((x) => x.task === "quiet").labelled).toBe(2);
  await expect(again.locator("#status")).toHaveText("");
});

test("the end screen says every answer is saved", async ({ page, request }) => {
  await start(page, "overlap");
  await tap(page, "overlap", "one");
  await waitPosts(request, 1);
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.locator("#done-pending")).toHaveText("Every answer is saved on the server.");
});

async function violations(page) {
  return (await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("confirm my voice: only the ticked lines are sent", async ({ page, request }) => {
  await start(page, "voice");
  await tap(page, "source", "me");
  await tap(page, "source", "me");
  await tap(page, "source", "me");
  await tap(page, "source", "live");
  await waitPosts(request, 4);
  await page.goto("/");
  await page.getByRole("button", { name: "Review" }).click();
  const boxes = page.locator(".confirm-list input");
  await expect(boxes).toHaveCount(3);
  const untick = await boxes.nth(1).getAttribute("data-label-id");
  await boxes.nth(1).uncheck();
  await page.locator("button[data-action=confirm-voice]").click();
  await expect(page.locator("#voice-learned")).toHaveText("2 lines taught your voiceprint.");
  const confirm = (await posts(request)).find((p) => p.confirm).confirm;
  expect(confirm.labelIds).toHaveLength(2);
  expect(confirm.labelIds).not.toContain(Number(untick));
});

test("no accessibility violations on the task list and a card", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("button[data-task=device]")).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.locator("button[data-task=device]").click();
  await page.locator("details.optional summary").click();
  expect(await violations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
