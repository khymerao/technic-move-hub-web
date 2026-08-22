// The message shapes both sides of the macro boundary agree on, and the
// correlation-id plumbing. Pure: no postMessage, no worker, no DOM.
//
// Nothing here is a security boundary. The worker runs user code, and user
// code can call self.postMessage directly and forge any of these. Every rule
// is enforced on the host, per message.

// `new AsyncFunction(names, body)` produces
//   async function anonymous(names
//   ) {
//   <body>
// so the user's first line is the third. A reported line minus this is real.
export const SOURCE_LINE_OFFSET = 2;

// waitUntil's poll interval. Shared by the worker (which runs the loop) and
// the host (which paces the RPCs the loop makes), so there is one value
// instead of two literals that can drift apart.
export const WAIT_UNTIL_POLL_MS = 50;

export function createCaller(post) {
  let seq = 0;
  const pending = new Map();

  return {
    get pending() { return pending.size; },

    call(method, args) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ kind: 'call', id, method, args });
      });
    },

    settle(msg) {
      const entry = pending.get(msg.id);
      if (!entry) return;              // a late reply from an aborted run
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.value);
      else {
        const err = new Error(msg.error?.message ?? 'macro call failed');
        err.name = msg.error?.name ?? 'Error';
        entry.reject(err);
      }
    },
  };
}
