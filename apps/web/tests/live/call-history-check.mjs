// Opt-in real-provider test: synthetic caller, ordinary pilot auth, no phone/SMS.
// node apps/web/tests/live/call-history-check.mjs [baseUrl] [callerWav] [seconds]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {closeSync, fchmodSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
/** @typedef {{speaker: string, text: string, language?: string, idx?: number}} QaTurn */
/** @typedef {{id: string, caller_anchor: string, manual_checkpoints: string[]}} QaScenario */
/** @typedef {{firstAudioMs: number | null, readyAt: number | null, maxAhead: number, scheduled: number, inputSpeech: number[][], outputSpeech: number[][]}} QaAudio */
/** @typedef {Window & {__callAudio?: QaAudio, __callTracks?: MediaStreamTrack[]}} QaWindow */
// Pure helpers are importable for offline correlation tests, without auth or AI.
/** @param {string} name */
export function validateReportName(name) {
  assert(name.toLowerCase() !== 'runtime.json', 'runtime.json is a reserved report filename');
  assert(/^[a-z0-9_-]+\.json$/i.test(name), 'Use a simple report filename');
}

/** @param {string} id @returns {QaScenario} */
export function loadScenario(id) {
  const scenarios = JSON.parse(readFileSync(resolve(root, 'apps/web/tests/fixtures/voice-quality-scenarios.json'), 'utf8'));
  assert(Object.hasOwn(scenarios, id), 'Unknown CALL_QA_SCENARIO');
  return scenarios[id];
}

/**
 * @param {{id: string, source: string}[]} calls
 * @param {Set<string>} priorIds
 * @param {Record<string, QaTurn[]>} turnsById
 * @param {QaScenario} scenario
 */
export function correlateScenarioCall(calls, priorIds, turnsById, scenario) {
  const normalized = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const anchor = ` ${normalized(scenario.caller_anchor)} `;
  const matches = calls.filter((call) => call.source === 'browser' && !priorIds.has(call.id)
    && (turnsById[call.id] || []).some((turn) => turn.speaker === 'caller'
      && ` ${normalized(turn.text)} `.includes(anchor)));
  assert(matches.length <= 1, 'Ambiguous scenario anchor: no call selected');
  return matches[0];
}

/** @param {QaScenario} scenario @param {QaTurn[]} turns */
export function scenarioReview(scenario, turns) {
  return {id: scenario.id, status: 'pending', syntheticTranscript: turns.map(({speaker, text, language, idx}) => ({
    speaker, text, ...(language === undefined ? {} : {language}), ...(idx === undefined ? {} : {idx}),
  })),
    manualCheckpoints: scenario.manual_checkpoints};
}

async function main() {
const reportName = process.env.CALL_QA_REPORT || 'call-usage-live.json';
validateReportName(reportName);
const scenario = process.env.CALL_QA_SCENARIO ? loadScenario(process.env.CALL_QA_SCENARIO) : null;
const require = createRequire(resolve(root, 'apps/web/package.json'));
const {chromium, devices} = require('@playwright/test');
const state = JSON.parse(readFileSync(resolve(root, 'tmp/phone-test/runtime.json'), 'utf8'));
const [base = 'https://voice-receptionist-demo-ten.vercel.app', wav = 'scripts/dev/voice-test/combined.wav', secondsText = '26'] = process.argv.slice(2);
const seconds = Number(secondsText);
assert(Number.isFinite(seconds) && seconds >= 15 && seconds <= 120);

function clusters(intervals, gapMs) {
  const result = [];
  for (const interval of intervals.toSorted((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && interval[0] - previous[1] <= gapMs) previous[1] = Math.max(previous[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

function responseLatency(audio) {
  const inputs = clusters(audio.inputSpeech, 1000).filter(([start, end]) => end - start >= 800);
  const outputs = clusters(audio.outputSpeech, 350);
  const replies = inputs.map(([start, end], index) => {
    const nextInput = inputs[index + 1]?.[0] ?? Infinity;
    const output = outputs.find(([began]) => began >= end && began < nextInput);
    return {customerEndMs: end, responseMs: output ? Math.round(output[0] - end) : null,
      overlappingReply: outputs.some(([began, stopped]) => began >= start && began < end && stopped > end)};
  });
  const values = replies.map((reply) => reply.responseMs).filter((value) => value !== null).toSorted((a, b) => a - b);
  return {replies, samples: values.length,
    p50Ms: values.length ? values[Math.max(0, Math.ceil(values.length * 0.5) - 1)] : null,
    p95Ms: values.length ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : null};
}
const db = state.database_public_url || state.env.NEXT_PUBLIC_SUPABASE_URL;
const key = state.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || state.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(key && db, 'Missing publishable database configuration');
console.log('QA: authenticating pilot');
const auth = await fetch(`${db}/auth/v1/token?grant_type=password`, {
  signal: AbortSignal.timeout(20000),
  method: 'POST', headers: {apikey: key, 'Content-Type': 'application/json'},
  body: JSON.stringify({email: state.email, password: state.password}),
});
assert(auth.ok, `Pilot sign-in failed: HTTP ${auth.status}`);
const {access_token: token} = await auth.json();
async function rows(table, query = '') {
  const response = await fetch(`${db}/rest/v1/${table}?select=*&${query}`, {signal: AbortSignal.timeout(20000), headers: {apikey: key, Authorization: `Bearer ${token}`}});
  assert(response.ok, `${table} read failed: HTTP ${response.status}`);
  return response.json();
}
console.log('QA: reading initial database state');
const businessTables = ['bookings', 'orders', 'sms_log', 'usage_ledger'];
const before = Object.fromEntries(await Promise.all(businessTables.map(async (table) => [table, await rows(table)])));
const priorIds = new Set((await rows('calls')).map((row) => row.id));
const browser = await chromium.launch({headless: true, args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${resolve(root, wav)}%noloop`,
]});
const context = await browser.newContext({...devices['Pixel 7'], permissions: ['microphone'], bypassCSP: Boolean(process.env.CALL_QA_WORKER)});
await context.addInitScript(() => {
  const qaWindow = /** @type {QaWindow} */ (window);
  qaWindow.__callAudio = {firstAudioMs: null, readyAt: null, maxAhead: 0, scheduled: 0, inputSpeech: [], outputSpeech: []};
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength % 2 === 0) {
      const samples = new Int16Array(data);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      if (Math.sqrt(energy / samples.length) > 300 && qaWindow.__callAudio.inputSpeech.length < 8000) {
        const end = performance.now();
        qaWindow.__callAudio.inputSpeech.push([end - samples.length / 16, end]);
      }
    }
    return send.call(this, data);
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(when, ...args) {
    const info = qaWindow.__callAudio;
    info.firstAudioMs ??= info.readyAt === null ? null : performance.now() - info.readyAt;
    info.maxAhead = Math.max(info.maxAhead, when + this.buffer.duration - this.context.currentTime);
    info.scheduled++;
    const samples = this.buffer.getChannelData(0);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    if (Math.sqrt(energy / samples.length) > 0.006 && info.outputSpeech.length < 8000) {
      const began = performance.now() + Math.max(0, when - this.context.currentTime) * 1000;
      info.outputSpeech.push([began, began + this.buffer.duration * 1000]);
    }
    return start.call(this, when, ...args);
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await capture(...args);
    qaWindow.__callTracks = stream.getTracks();
    return stream;
  };
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true, get: descriptor.get,
    set(callback) {
      descriptor.set.call(this, (event) => {
        if (typeof event.data === 'string') {
          try { if (JSON.parse(event.data).type === 'ready') qaWindow.__callAudio.readyAt = performance.now(); } catch {}
        }
        callback?.call(this, event);
      });
    },
  });
});
const page = await context.newPage();
// Optional loopback-only backend for isolated worker diagnosis, with the same signed token/origin.
if (process.env.CALL_QA_WORKER) {
  const target = new URL(process.env.CALL_QA_WORKER);
  assert(target.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(target.hostname));
  assert(new URL(base).hostname === 'localhost', 'Isolated worker requires local UI');
  await page.route('**/api/demo/session', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({response, json: {...data, websocketUrl: target.toString()}});
  });
}
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
try {
  console.log('QA: opening browser call');
  assert.equal((await page.goto(base + '/demo')).status(), 200);
  assert.match(await page.locator('main').innerText(), /AI assistant/);
  await page.getByLabel(/^Access code/).fill(state.env.VOICE_DEMO_ACCESS_CODE);
  await page.getByRole('button', {name: 'Start call', exact: true}).click();
  try {
    await page.getByRole('button', {name: 'Mute microphone', exact: true}).waitFor({timeout: 25000});
  } catch {
    const alert = page.locator('main [role=alert]');
    throw new Error(await alert.count() ? await alert.first().innerText() : 'Call did not connect within 25 seconds');
  }
  console.log('QA: connected; playing synthetic caller');
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(250);
    assert.equal(await page.locator('main [role=alert]').count(), 0, 'Call reported an error');
  }
  await page.getByRole('button', {name: 'End call', exact: true}).click();
  assert(await page.evaluate(() => /** @type {QaWindow} */ (window).__callTracks.every((track) => track.readyState === 'ended')));
  const scheduled = await page.evaluate(() => /** @type {QaWindow} */ (window).__callAudio.scheduled);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => /** @type {QaWindow} */ (window).__callAudio.scheduled), scheduled, 'Audio scheduled after hang-up');
  const audio = await page.evaluate(() => /** @type {QaWindow} */ (window).__callAudio);
  assert(audio.scheduled > 10, 'No real streamed audio scheduled');
  console.log('QA: checking saved call');
  let call;
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidates = (await rows('calls', 'source=eq.browser&order=started_at.desc')).filter((row) => !priorIds.has(row.id));
    if (scenario) {
      // Only caller text in new browser calls qualifies. Never fall back to newest.
      assert(candidates.length <= 20, 'Too many new calls to correlate safely');
      /** @type {Record<string, QaTurn[]>} */
      const turnsById = {};
      for (const candidate of candidates) {
        assert(/^[a-f0-9-]{36}$/i.test(candidate.id), 'Invalid call identity');
        turnsById[candidate.id] = await rows('call_turns', `call_id=eq.${candidate.id}&order=idx`);
      }
      call = correlateScenarioCall(candidates, priorIds, turnsById, scenario);
    } else {
      call = candidates[0];
    }
    if (call?.ended_at) break;
    await page.waitForTimeout(500);
  }
  assert(call?.ended_at, 'Browser call did not finalize');
  assert.equal(call.billable_seconds, 0);
  assert.equal(call.from_last4, null);
  assert.equal(call.telnyx_call_id, null);
  assert.equal(call.recording_path, null);
  assert(call.usage.totals.prompt_tokens > 0 && call.usage.totals.completion_tokens > 0, 'Provider LLM tokens missing');
  assert(call.cost_micros.llm > 0, 'Priced LLM usage missing');
  assert.equal(call.usage.currency, 'USD');
  const turns = await rows('call_turns', `call_id=eq.${call.id}&order=idx`);
  assert(turns.some((turn) => turn.speaker === 'caller') && turns.some((turn) => turn.speaker === 'agent'), 'Conversation text missing');
  const languageFailures = [];
  if (wav.includes('language-switch-caller')) {
    /** @type {[string, RegExp][]} */
    const languageScripts = [['ur', /\p{Script=Arabic}/u], ['te', /\p{Script=Telugu}/u]];
    for (const [language, script] of languageScripts) {
      assert(call.languages.includes(language), `Missing ${language} in call languages`);
      if (!turns.some((turn) => turn.speaker === 'agent' && turn.language === language && script.test(turn.text) && /seventeen/i.test(turn.text))) {
        languageFailures.push(`Missing ${language} reply with English price words and the correct transcript tag`);
      }
    }
  }
  for (const table of businessTables) assert.deepEqual(await rows(table), before[table], `${table} changed during browser practice`);
  console.log('QA: checking dashboard');
  await page.goto(base + '/login');
  await page.locator('input[name="email"]').fill(state.email);
  await page.locator('input[name="password"]').fill(state.password);
  await Promise.all([page.waitForURL('**/home', {timeout: 45000}), page.locator('button[name="intent"][value="password"]').click()]);
  assert.equal((await page.goto(base + '/calls')).status(), 200);
  const link = page.locator(`a[href="/calls/${call.id}"]`);
  assert.match(await link.innerText(), /Browser test call/);
  assert.match(await link.innerText(), /LLM tokens/);
  await link.click();
  await page.getByRole('heading', {name: 'Usage and cost', exact: true}).waitFor();
  const text = await page.locator('main').innerText();
  assert.match(text, /Input LLM tokens/);
  assert.match(text, /USD/);
  assert(!text.includes('••• ••• null'));
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'Mobile horizontal overflow');
  await page.screenshot({path: resolve(root, 'tmp/phone-test/call-usage-mobile.png'), fullPage: true});
  assert.equal(pageErrors.length, 0, 'Browser page errors');
  const result = {callId: call.id, durationSeconds: (Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000,
    languages: call.languages, tokens: call.usage.totals.total_tokens, costStatus: call.usage.cost_status,
    costMicros: call.cost_micros, transcriptTurns: turns.length, billableSeconds: 0,
    audio, clientResponseLatency: responseLatency(audio), languageFailures, pageErrors, businessWrites: 0};
  result.estimatedKnownUsdPerMinute = Object.values(call.cost_micros).reduce((sum, value) => sum + value, 0) / 1_000_000 / (result.durationSeconds / 60);
  if (scenario) result.scenarioReview = scenarioReview(scenario, turns);
  const report = openSync(resolve(root, 'tmp/phone-test', reportName), 'w', 0o600);
  try {
    fchmodSync(report, 0o600);
    writeFileSync(report, JSON.stringify(result, null, 2));
  } finally {
    closeSync(report);
  }
  // Transcript is private report data only; never dump caller text to stdout.
  const {scenarioReview: review, ...metrics} = result;
  console.log(JSON.stringify({...metrics, ...(review ? {scenario: review.id, manualReviewStatus: review.status} : {}), audio: {firstAudioMs: audio.firstAudioMs, maxAhead: audio.maxAhead, scheduled: audio.scheduled}}));
  assert.deepEqual(languageFailures, [], 'Language/number quality checks failed');
} finally {
  await browser.close();
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
