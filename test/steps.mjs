import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { After, Before, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';
import { By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const baseUrl = process.env.SUPPORT_BASE_URL ?? 'http://127.0.0.1:4317';
const runtime = process.env.SUPPORT_RUNTIME ?? fileURLToPath(new URL('../../runtime/', import.meta.url));
setDefaultTimeout(40_000);

async function click(driver, id) {
  const element = await driver.wait(until.elementLocated(By.id(id)), 10_000);
  await driver.wait(until.elementIsVisible(element), 10_000);
  await driver.wait(until.elementIsEnabled(element), 10_000);
  await element.click();
}

async function getJson(path) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(5_000) });
  assert.ok(response.ok, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function submittedTicket(driver) {
  const status = await driver.findElement(By.id('intake-message'));
  const message = await driver.wait(async () => {
    const text = await status.getText();
    return /Ticket #(\d+) submitted\./.test(text) && text;
  }, 25_000);
  const id = Number(message.match(/Ticket #(\d+)/)[1]);
  const detail = await driver.findElement(By.id('ticket-detail'));
  await driver.wait(until.elementIsVisible(detail), 10_000);
  await driver.wait(until.elementTextIs(await driver.findElement(By.id('detail-id')), `#${id}`), 10_000);
  return id;
}

async function upload(driver, path) {
  await click(driver, 'image-mode');
  await driver.findElement(By.id('ticket-image')).sendKeys(path);
  await click(driver, 'submit-ticket');
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function devToolsAddress(profile, browser) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && browser.exitCode === null && browser.signalCode === null && browser.pid) {
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (/^\d+$/.test(port)) return `127.0.0.1:${port}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  throw new Error('The project-local headless browser did not start DevTools');
}

Before(async function () {
  const { SUPPORT_CHROME, SUPPORT_CHROMEDRIVER, SUPPORT_CHROME_LOG } = process.env;
  assert.ok(SUPPORT_CHROME && SUPPORT_CHROMEDRIVER,
    'Set SUPPORT_CHROME and SUPPORT_CHROMEDRIVER to the project-local browser binaries');
  const testPath = resolve(runtime, 'test');
  await mkdir(testPath, { recursive: true });
  this.scratch = await mkdtemp(join(testPath, 'browser-'));
  const profile = join(this.scratch, 'profile');
  // Headless Shell needs an explicit initial page or ChromeDriver waits for a target.
  this.browser = spawn(SUPPORT_CHROME, [
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--window-size=1280,960', '--disable-background-networking',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { env: { ...process.env, TMPDIR: this.scratch }, stdio: 'ignore' });
  this.browserExit = new Promise((resolveExit) => {
    this.browser.once('error', resolveExit);
    this.browser.once('exit', () => resolveExit(true));
  });
  const address = await devToolsAddress(profile, this.browser);
  const builder = new chrome.ServiceBuilder(SUPPORT_CHROMEDRIVER);
  if (SUPPORT_CHROME_LOG) builder.loggingTo(SUPPORT_CHROME_LOG).enableVerboseLogging();
  this.service = builder.build();
  this.driver = await chrome.Driver.createSession(new chrome.Options().debuggerAddress(address), this.service);
});

After(async function () {
  try {
    if (this.driver) await this.driver.quit();
  } finally {
    if (this.service) await this.service.kill();
    if (this.browser?.pid && this.browser.exitCode === null && this.browser.signalCode === null) {
      this.browser.kill('SIGTERM');
      if (!(await Promise.race([this.browserExit, delay(3000, null, { ref: false })]))) {
        this.browser.kill('SIGKILL');
        await this.browserExit;
      }
    }
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true });
  }
});

Given('the Support Intake dashboard is open', async function () {
  await this.driver.get(baseUrl);
  await this.driver.wait(until.elementLocated(By.id('ticket-list')), 10_000);
});

When('I submit the text {string}', async function (text) {
  this.inputText = text;
  await this.driver.findElement(By.id('ticket-text')).sendKeys(text);
  await click(this.driver, 'submit-ticket');
  this.textTicketId = await submittedTicket(this.driver);
});

Then('the ticket should be in manual review', async function () {
  const { ticket } = await getJson(`/api/tickets/${this.textTicketId}`);
  assert.equal(ticket.status, 'review');
  const status = await this.driver.findElement(By.id('detail-status')).getText();
  assert.match(status, /review/i);
  const filter = await this.driver.findElement(By.id('queue-filter'));
  await filter.findElement(By.css('option[value="review"]')).click();
  await this.driver.wait(until.elementLocated(
    By.css(`#ticket-list [data-ticket-id="${ticket.id}"]`)), 10_000);
});

When('I correct its intent and leave a note', async function () {
  const { ticket } = await getJson(`/api/tickets/${this.textTicketId}`);
  const { intents } = await getJson('/api/intents');
  this.correctedIntent = intents.find((intent) => intent !== ticket.intent);
  this.note = 'Checked the text and selected the correct queue.';
  const option = await this.driver.wait(until.elementLocated(
    By.css(`#review-intent option[value="${this.correctedIntent}"]`)), 10_000);
  await option.click();
  await this.driver.findElement(By.id('review-note')).sendKeys(this.note);
  await click(this.driver, 'save-review');
  await this.driver.wait(until.elementTextContains(
    await this.driver.findElement(By.id('review-message')), 'Review saved.'), 15_000);
});

Then('the ticket should be routed with the correction in its history', async function () {
  const { ticket, history } = await getJson(`/api/tickets/${this.textTicketId}`);
  assert.equal(ticket.status, 'routed');
  assert.equal(ticket.intent, this.correctedIntent);
  assert.equal(history.at(-1).note, this.note);
  const status = await this.driver.findElement(By.id('detail-status')).getText();
  assert.match(status, /routed/i);
  await this.driver.wait(until.elementTextContains(
    await this.driver.findElement(By.id('ticket-history')), this.note), 10_000);
});

When('I submit a screenshot of the same message', async function () {
  const data = await this.driver.executeScript((message) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#161616';
    ctx.font = '48px Arial';
    ctx.fillText(message, 35, 105);
    return canvas.toDataURL('image/png').split(',')[1];
  }, this.inputText);
  const path = join(this.scratch, 'support-message.png');
  await writeFile(path, Buffer.from(data, 'base64'));
  await upload(this.driver, path);
  this.imageTicketId = await submittedTicket(this.driver);
  assert.notEqual(this.imageTicketId, this.textTicketId);
});

Then('the screenshot should produce the expected text and intent', async function () {
  const { ticket: imageTicket } = await getJson(`/api/tickets/${this.imageTicketId}`);
  const { ticket: textTicket } = await getJson(`/api/tickets/${this.textTicketId}`);
  assert.equal(imageTicket.source, 'image');
  assert.equal(imageTicket.status, 'review');
  assert.equal(normalize(imageTicket.text), normalize(this.inputText));
  assert.equal(imageTicket.intent, textTicket.intent);
  const shownText = await this.driver.findElement(By.id('detail-text')).getText();
  assert.equal(normalize(shownText), normalize(this.inputText));
});

When('I submit a fake PNG', async function () {
  const before = await getJson('/api/tickets');
  this.idsBefore = before.tickets.map(({ id }) => id);
  const path = join(this.scratch, 'invalid.png');
  await writeFile(path, 'A .png filename does not make this an image.');
  await upload(this.driver, path);
});

Then('the invalid upload should show an error without creating a ticket', async function () {
  const status = await this.driver.wait(until.elementLocated(By.css('#intake-message.is-error')), 15_000);
  const error = await status.getText();
  assert.match(error, /screenshot.+file type/i);
  assert.doesNotMatch(error, /Ticket #\d+ submitted/);
  const after = await getJson('/api/tickets');
  assert.deepEqual(after.tickets.map(({ id }) => id), this.idsBefore);
});
