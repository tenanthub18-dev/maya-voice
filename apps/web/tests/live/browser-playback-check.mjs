// Opt-in live-provider check; never part of the offline Vitest suite.
// Run from any directory: node <this file> [url] [burstMs] [attempts] [holdAfterMs]
// Uses private local demo credentials and a prerecorded synthetic caller. No
// telephone/SMS activity or real customer data. Speech/LLM API usage applies.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(resolve(root, 'apps/web/package.json'));
const {chromium, devices} = require('@playwright/test');
const state = JSON.parse(readFileSync(resolve(root, 'tmp/phone-test/runtime.json'), 'utf8'));
const [base = 'https://voice-receptionist-demo-ten.vercel.app', burstText = '2200', attemptsText = '3', holdAfterText = '0'] = process.argv.slice(2);
const burstMs = Number(burstText), attempts = Number(attemptsText), holdAfterMs = Number(holdAfterText);
assert(Number.isFinite(burstMs) && burstMs >= 0 && burstMs <= 4000);
assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 5);
const durationMs = Math.max(26000, holdAfterMs + burstMs + 5000);
const browser = await chromium.launch({headless: true, args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${resolve(root, 'scripts/dev/voice-test/combined.wav')}%noloop`,
]});
const context = await browser.newContext({...devices['Pixel 7'], permissions: ['microphone']});
await context.addInitScript(({burstMs, holdAfterMs}) => {
  window.__playback = {scheduledFrames: 0, maxAhead: 0, activeSources: 0, maxSources: 0, audioBytes: 0, heldFrames: 0, releasedBatches: 0};
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(when, ...args) {
    const m = window.__playback;
    m.scheduledFrames++;
    m.maxAhead = Math.max(m.maxAhead, when + this.buffer.duration - this.context.currentTime);
    m.maxSources = Math.max(m.maxSources, ++m.activeSources);
    this.addEventListener('ended', () => { m.activeSources--; }, {once: true});
    return start.call(this, when, ...args);
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await capture(...args);
    window.__captureTracks = stream.getTracks();
    return stream;
  };
  // Deliberately batch real incoming frames without blocking microphone capture.
  // This is a test-only network delivery shim, never a production audio path.
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true, get: descriptor.get,
    set(callback) {
      let held = false, queue = null;
      const opened = performance.now();
      descriptor.set.call(this, (event) => {
        if (event.data instanceof ArrayBuffer) {
          window.__playback.audioBytes += event.data.byteLength;
          if (!held && burstMs > 0 && performance.now() - opened >= holdAfterMs) {
            held = true; queue = [];
            setTimeout(() => {
              const batch = queue; queue = null;
              window.__playback.releasedBatches++;
              for (const message of batch) callback?.call(this, message);
            }, burstMs);
          }
        }
        if (queue) { queue.push(event); window.__playback.heldFrames++; }
        else callback?.call(this, event);
      });
    },
  });
}, {burstMs, holdAfterMs});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const results = [];
try {
  assert.equal((await page.goto(base + '/demo')).status(), 200);
  await page.getByLabel(/^Access code/).fill(state.env.VOICE_DEMO_ACCESS_CODE);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.evaluate(() => {
      window.__playback = {scheduledFrames: 0, maxAhead: 0, activeSources: 0, maxSources: 0, audioBytes: 0, heldFrames: 0, releasedBatches: 0};
    });
    await page.getByRole('button', {name: 'Start call', exact: true}).click();
    await page.getByRole('button', {name: 'Mute microphone', exact: true}).waitFor({timeout: 25000});
    const started = Date.now();
    while (Date.now() - started < durationMs) {
      await page.waitForTimeout(200);
      const alerts = page.locator('main [role=alert]');
      if (await alerts.count()) throw new Error(await alerts.first().innerText());
    }
    const metrics = await page.evaluate(() => window.__playback);
    assert(metrics.audioBytes > 32000 && metrics.scheduledFrames > 10, 'Missing real streamed audio');
    if (burstMs) {
      assert(metrics.heldFrames > 20, 'Audio-burst simulation was not exercised');
      assert.equal(metrics.releasedBatches, 1, 'Delayed audio was not released before hang-up');
    }
    await page.getByRole('button', {name: 'End call', exact: true}).click();
    assert(await page.evaluate(() => window.__captureTracks.every((track) => track.readyState === 'ended')), 'Microphone leaked after hang-up');
    // Audio may legitimately schedule while Playwright moves to/clicks End.
    // Compare only after the synchronous hang-up handler has actually run.
    const scheduled = await page.evaluate(() => window.__playback.scheduledFrames);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => window.__playback.scheduledFrames), scheduled, 'Audio scheduled after hang-up');
    results.push({attempt, burstMs, holdAfterMs, ...metrics, scheduledFrames: scheduled, tracksEnded: true, framesAfterHangup: 0});
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.equal(pageErrors.length, 0, 'Browser page errors');
} finally {
  writeFileSync(resolve(root, 'tmp/phone-test/playback-live.json'), JSON.stringify({results, pageErrors}, null, 2));
  await browser.close();
}
