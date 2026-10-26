import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terminalChunk,terminalText,parseJobs,selectSession,TERMINAL_LIMIT} from '../src/web/ui-model.js';

test('empty and stopped terminal lists clear selection without merging null; polling retains the live session',()=>{
  assert.equal(selectSession([],null,'saved'),null);
  assert.equal(selectSession([],{sessionName:'stopped'},'stopped'),null);
  const current={sessionName:'live',nextOffsetChars:2};
  assert.equal(selectSession([{sessionName:'live',nextOffsetChars:3}],current),current);
  assert.equal(current.nextOffsetChars,3);
  assert.equal(selectSession([{sessionName:'first'},{sessionName:'saved'}],null,'saved').sessionName,'saved');
});

test('terminal advances beyond 64 KiB and keeps later output instead of rereading the same window',()=>{
  let state=terminalChunk(undefined,{output:'x'.repeat(65536),nextOffsetChars:65536},0);
  state=terminalChunk(state,{output:'x'.repeat(15000)+'LATER',nextOffsetChars:80541},state.offset);
  assert.equal(state.offset,80541);assert.ok(state.text.endsWith('LATER'));
  state=terminalChunk(state,{output:'\nNEXT',nextOffsetChars:80546},state.offset);
  assert.ok(state.text.endsWith('LATER\nNEXT'));
  state=terminalChunk(state,{output:'y'.repeat(TERMINAL_LIMIT)+'FINAL',nextOffsetChars:80546+TERMINAL_LIMIT+5},state.offset);
  assert.equal(state.text.length,TERMINAL_LIMIT);assert.ok(state.text.endsWith('FINAL'));
});
test('terminal truncation does not concatenate disjoint history and an empty read retains its buffer',()=>{
  const first={text:'old',offset:3};
  const reset=terminalChunk(first,{output:'new',nextOffsetChars:1003,truncated:true},3);
  assert.equal(reset.text,'new');assert.deepEqual(terminalChunk(reset,{output:'',nextOffsetChars:1003},1003),reset);
});
test('terminal rendering removes Linux title and color escapes without removing text',()=>{
  assert.equal(terminalText('\x1b]0;remote-title\x07\x1b[32mhello\x1b[0m\r\nworld'),'hello\nworld');
  assert.equal(terminalText('\x1b]0;title\x1b\\safe'),'safe');
});
test('job rows preserve exit codes and commands, including commands with status-like words',()=>{
  assert.deepEqual(parseJobs('(no jobs)'),[]);
  const jobs=parseJobs('[stdout]\njob-abc  running  sleep 30\njob-def  exited (exit 7)  echo running\njob-ghi  killed  sleep 40');
  assert.equal(jobs.length,3);assert.equal(jobs[0].state,'running');assert.equal(jobs[1].exitCode,7);assert.equal(jobs[1].command,'echo running');assert.equal(jobs[2].state,'killed');
});


test('same-name worker replacement uses a fresh session object so old reads cannot mutate it',()=>{
  const old={sessionName:'shared',pid:101,startedAt:'old',nextOffsetChars:9000};
  const fresh={sessionName:'shared',pid:202,startedAt:'new',nextOffsetChars:3};
  assert.equal(selectSession([fresh],old),fresh);
  assert.equal(old.pid,101);
  assert.equal(old.nextOffsetChars,9000);
});
