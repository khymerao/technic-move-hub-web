// State machine for the macro run lifecycle.

import { log } from '../debug-log.js';

const STATES = ['idle', 'arming', 'running', 'stopping', 'failed'];

const ALLOWED = {
  run: ['idle'],  // 'run' excludes 'stopping'
  abort: ['arming', 'running'],
};

export function createRunState({ onChange } = {}) {
  let state = 'idle';
  const api = {
    get state() { return state; },
    can(action) { return (ALLOWED[action] ?? []).includes(state); },
    // `detail` rides along to onChange only, not into the state machine;
    // host.js uses it to carry a failed run's error onto the 'failed'
    // transition.
    to(next, detail) {
      if (!STATES.includes(next)) throw new Error(`unknown run state: ${next}`);
      if (next === state) return;
      const from = state;
      state = next;
      // A listener throwing here used to escape the caller mid-transition and
      // leave the machine latched in whatever state it had just assigned.
      // See docs/DESIGN-NOTES.md § A listener must not be able to latch the run state
      try {
        onChange?.(next, from, detail);
      } catch (err) {
        log('run-state listener failed on', next + ':', err?.message ?? err);
      }
    },
    reset(detail) { api.to('idle', detail); },
  };
  return api;
}
