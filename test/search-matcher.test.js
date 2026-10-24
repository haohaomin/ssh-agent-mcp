import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchMatcher } from '../build/utils/search-matcher.js';

test('pathological regex is terminated without blocking the server; matcher recovers', { timeout: 10000 }, async () => {
  const matcher = new SearchMatcher();
  try {
    await assert.rejects(matcher.match('a'.repeat(100) + '!', '(a+)+$', {regex:true}, 10), /execution budget/);
    const result = await matcher.match('ok 42', 'ok \\d+', {regex:true}, 10);
    assert.equal(result.count, 1);
  } finally { matcher.close(); }
});
