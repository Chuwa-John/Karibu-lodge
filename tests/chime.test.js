// tests/chime.test.js — the console bell, against a fake Web Audio API.
//
// What matters is not the tune but the failure modes: a browser with no audio,
// a page nobody has clicked yet, a device that will not open, and a resume()
// that never settles. None of them may throw, hang, or claim to have rung.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createChime } from '../js/lib/chime.js';

function fakeAudio({ allowResume = true, resumeNeverSettles = false, throwOnCreate = false, brokenGraph = false } = {}) {
  const made = [];
  class FakeAudioContext {
    constructor() {
      if (throwOnCreate) throw new Error('no audio device');
      this.state = 'suspended';
      this.currentTime = 10;
      this.destination = { speakers: true };
      this.onstatechange = null;
      this.oscillators = [];
      this.gains = [];
      made.push(this);
    }
    resume() {
      if (resumeNeverSettles) return new Promise(() => {});
      if (!allowResume) return Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
      this.state = 'running';
      this.onstatechange?.();
      return Promise.resolve();
    }
    createOscillator() {
      if (brokenGraph) throw new Error('graph failure');
      const osc = {
        type: '', frequencyHz: null, startedAt: null,
        frequency: { setValueAtTime: hz => { osc.frequencyHz = hz; } },
        connect() {}, start: t => { osc.startedAt = t; }, stop() {},
      };
      this.oscillators.push(osc);
      return osc;
    }
    createGain() {
      // Loudness is part of the message, so the ramp targets are recorded.
      const node = {
        peaks: [],
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime: v => { node.peaks.push(v); },
        },
        connect() {},
      };
      this.gains.push(node);
      return node;
    }
  }
  return { FakeAudioContext, made };
}

describe('the bell', () => {
  test('a browser with no Web Audio says so, and never throws', async () => {
    const chime = createChime({ AudioContextImpl: null });
    assert.equal(chime.state, 'unsupported');
    assert.equal(chime.play(), false);
    assert.equal(await chime.unlock(), false);
  });

  test('before anyone clicks, it is blocked — and play says so rather than pretending', () => {
    const { FakeAudioContext, made } = fakeAudio();
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    assert.equal(chime.state, 'suspended');
    assert.equal(chime.play('arrival'), false);
    assert.equal(made.length, 0, 'no audio context is even opened without a click');
  });

  test('a click unlocks it: listeners hear about it, and it rings', async () => {
    const { FakeAudioContext, made } = fakeAudio();
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    const heard = [];
    chime.onChange(s => heard.push(s));

    assert.equal(await chime.unlock(), true);
    assert.equal(chime.state, 'running');
    assert.ok(heard.includes('running'));
    assert.equal(chime.play('arrival'), true);
    assert.ok(made[0].oscillators.length > 0);
  });

  test('each alert has its own sound', async () => {
    const { FakeAudioContext, made } = fakeAudio();
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    await chime.unlock();
    const notes = kind => {
      made[0].oscillators = [];
      chime.play(kind);
      return made[0].oscillators.map(o => o.frequencyHz);
    };
    assert.deepEqual(notes('arrival'), [880, 660], 'a ding-dong for a new booking');
    assert.deepEqual(notes('soon'), [587, 587], 'two level beeps for a hold running out');
    assert.deepEqual(notes('test'), [880]);
    assert.ok(made[0].oscillators.every(o => o.startedAt >= made[0].currentTime),
      'never scheduled in the past, where it would be silently skipped');
  });

  test('the payment bell is its own tune, and louder than the rest', async () => {
    // Reception must be able to tell, without looking up, that this one is
    // about money somebody has already sent.
    const { FakeAudioContext, made } = fakeAudio();
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    await chime.unlock();

    const ring = kind => {
      made[0].oscillators = [];
      made[0].gains = [];
      chime.play(kind);
      return {
        notes: made[0].oscillators.map(o => o.frequencyHz),
        peak: Math.max(...made[0].gains.flatMap(g => g.peaks)),
      };
    };

    const payment = ring('payment');
    const arrival = ring('arrival');
    const soon    = ring('soon');

    assert.deepEqual(payment.notes, [988, 1319, 988, 1319], 'four rising tones, unlike any other alert');
    assert.ok(payment.peak > arrival.peak && payment.peak > soon.peak,
      `money must ring louder: payment ${payment.peak}, arrival ${arrival.peak}, soon ${soon.peak}`);
  });

  test('a browser that refuses to start audio leaves it blocked, and says so', async () => {
    const { FakeAudioContext } = fakeAudio({ allowResume: false });
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    assert.equal(await chime.unlock(), false);
    assert.equal(chime.state, 'suspended');
    assert.equal(chime.play(), false);
  });

  test('a resume() that never settles cannot hang the console', async () => {
    const { FakeAudioContext } = fakeAudio({ resumeNeverSettles: true });
    const chime = createChime({ AudioContextImpl: FakeAudioContext, resumeTimeoutMs: 30 });
    const answer = await Promise.race([
      chime.unlock(),
      new Promise(r => setTimeout(() => r('__HUNG__'), 1000)),
    ]);
    assert.equal(answer, false);
    assert.equal(chime.state, 'suspended');
  });

  test('an audio device that will not open counts as no sound at all', async () => {
    const { FakeAudioContext } = fakeAudio({ throwOnCreate: true });
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    const heard = [];
    chime.onChange(s => heard.push(s));
    assert.equal(await chime.unlock(), false);
    assert.equal(chime.state, 'unsupported');
    assert.deepEqual(heard, ['unsupported']);
  });

  test('clicking again does not open a second audio context', async () => {
    const { FakeAudioContext, made } = fakeAudio();
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    await chime.unlock();
    await chime.unlock();
    assert.equal(made.length, 1);
  });

  test('if the sound graph fails mid-ring, play reports it instead of throwing', async () => {
    const { FakeAudioContext } = fakeAudio({ brokenGraph: true });
    const chime = createChime({ AudioContextImpl: FakeAudioContext });
    await chime.unlock();
    assert.doesNotThrow(() => chime.play());
    assert.equal(chime.play(), false);
  });
});
