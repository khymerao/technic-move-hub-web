import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunState } from '../src/macro/run-state.js';

test('starts idle', () => {
  assert.equal(createRunState().state, 'idle');
});

test('run is only allowed from idle', () => {
  const s = createRunState();
  assert.equal(s.can('run'), true);
  s.to('arming');
  assert.equal(s.can('run'), false);
  s.to('running');
  assert.equal(s.can('run'), false);
  s.to('stopping');
  assert.equal(s.can('run'), false, 'a second Run must not overlap cleanup');
});

test('abort is allowed while arming and while running, not while idle', () => {
  const s = createRunState();
  assert.equal(s.can('abort'), false);
  s.to('arming');
  assert.equal(s.can('abort'), true, 'Stop during the steering sweep must work');
  s.to('running');
  assert.equal(s.can('abort'), true);
});

test('stopping always returns to idle, even from failed cleanup', () => {
  const s = createRunState();
  s.to('arming'); s.to('running'); s.to('stopping'); s.to('failed');
  s.reset();
  assert.equal(s.state, 'idle', 'nothing may be left latched');
  assert.equal(s.can('run'), true);
});

test('onChange reports every transition', () => {
  const seen = [];
  const s = createRunState({ onChange: (to, from) => seen.push([from, to]) });
  s.to('arming');
  s.to('running');
  assert.deepEqual(seen, [['idle', 'arming'], ['arming', 'running']]);
});

test('a transition to the same state is not reported', () => {
  const seen = [];
  const s = createRunState({ onChange: (to) => seen.push(to) });
  s.to('arming');
  s.to('arming');
  assert.deepEqual(seen, ['arming']);
});

test('an unknown state is refused', () => {
  assert.throws(() => createRunState().to('sideways'), /unknown run state/);
});

test('a detail passed to to() rides along to onChange, not to reset()', () => {
  const seen = [];
  const s = createRunState({ onChange: (to, from, detail) => seen.push([to, detail]) });
  s.to('arming'); s.to('running'); s.to('stopping');
  s.to('failed', { message: 'boom' });
  s.reset();
  assert.deepEqual(seen, [
    ['arming', undefined], ['running', undefined], ['stopping', undefined],
    ['failed', { message: 'boom' }], ['idle', undefined],
  ]);
});

test('a throwing onChange listener cannot corrupt the machine', () => {
  const seen = [];
  const s = createRunState({
    onChange: (to) => { seen.push(to); if (to === 'stopping') throw new Error('panel blew up'); },
  });
  s.to('arming');
  s.to('running');
  s.to('stopping');            // must not throw out of to()
  assert.equal(s.state, 'stopping');
  s.reset();
  assert.equal(s.state, 'idle', 'a listener must not be able to latch the machine');
  assert.deepEqual(seen, ['arming', 'running', 'stopping', 'idle']);
});

test('reset passes its reason along to onChange', () => {
  const seen = [];
  const s = createRunState({ onChange: (to, from, detail) => seen.push([to, detail]) });
  s.to('running');
  s.reset('low signal');
  assert.deepEqual(seen, [['running', undefined], ['idle', 'low signal']]);
});

test('reset works when detached from the object', () => {
  const seen = [];
  const s = createRunState({ onChange: (to, from) => seen.push([from, to]) });
  const { reset } = s;
  s.to('running');
  reset();
  assert.equal(s.state, 'idle');
  assert.deepEqual(seen, [['idle', 'running'], ['running', 'idle']]);
});
