import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityPanel } from '../src/web/activity.js';

test('activity storage warning clears on recovery even while display is paused', t => {
  const notice = { hidden: true, textContent: '' };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => notice } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  const panel = Object.create(ActivityPanel.prototype);
  panel.paused = true;
  panel.accept({ type: 'storage-error' });
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /写入失败/);
  panel.accept({ type: 'storage-recovered' });
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
});
