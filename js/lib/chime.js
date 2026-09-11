// js/lib/chime.js
//
// The console's bell, synthesised with the Web Audio API so there is no sound
// file to fail to download.
//
// Browsers refuse to play sound until someone has clicked or typed on the page.
// A console reopened on a remembered sign-in has had no click, so its bell is
// silent until somebody touches it. This module does not hide that: `state`
// reports it, and the console keeps a warning on screen until it is fixed.
//
//   'running'     the bell will ring
//   'suspended'   blocked until someone clicks or types on the page
//   'unsupported' this browser or machine cannot ring at all

const TUNES = {
  // [frequency Hz, start offset s, length s]
  arrival: [[880, 0, 0.35], [660, 0.32, 0.6]],   // ding-dong
  soon:    [[587, 0, 0.4], [587, 0.5, 0.4]],     // two level beeps: something is running out
  test:    [[880, 0, 0.25]],
};

export function createChime({
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  resumeTimeoutMs = 1500,
} = {}) {
  let ctx = null;
  let broken = !AudioContextImpl;
  const listeners = new Set();

  const state = () => {
    if (broken) return 'unsupported';
    return ctx && ctx.state === 'running' ? 'running' : 'suspended';
  };
  const notify = () => {
    const s = state();
    listeners.forEach(fn => fn(s));
  };

  /**
   * Call from inside a click or key handler — the only moment a browser lets
   * sound start. Resolves true if the bell will now ring. Never hangs: a browser
   * that will not start audio can leave resume() pending forever.
   */
  async function unlock() {
    if (broken) return false;
    if (!ctx || ctx.state === 'closed') {
      try {
        ctx = new AudioContextImpl();
        ctx.onstatechange = notify;
      } catch {
        broken = true;
        notify();
        return false;
      }
    }
    if (ctx.state !== 'running') {
      let timer;
      try {
        await Promise.race([
          ctx.resume(),
          new Promise(r => { timer = setTimeout(r, resumeTimeoutMs); }),
        ]);
      } catch {
        // still blocked; state says so
      } finally {
        clearTimeout(timer);
      }
    }
    notify();
    return state() === 'running';
  }

  /** Rings now if it can. Returns false when it cannot — never throws. */
  function play(kind = 'arrival') {
    if (state() !== 'running') return false;
    try {
      const t0 = ctx.currentTime + 0.02;
      for (const [freq, offset, length] of TUNES[kind] || TUNES.arrival) {
        const osc   = ctx.createOscillator();
        const gain  = ctx.createGain();
        const start = t0 + offset;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.6, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + length + 0.05);
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    unlock,
    play,
    get state() { return state(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
