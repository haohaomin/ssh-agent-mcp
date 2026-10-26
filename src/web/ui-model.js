// Shared presentation helpers, independent of browser state for regression tests.
export const TERMINAL_LIMIT = 131072;
export function sessionIdentity(session) {
  return session ? JSON.stringify([session.sessionName, session.pid ?? null, session.startedAt ?? null]) : '';
}
export function selectSession(sessions, current, savedName) {
  const wanted = current?.sessionName || savedName;
  const found = sessions.find(session => session.sessionName === wanted) || sessions[0] || null;
  return found && sessionIdentity(current) === sessionIdentity(found) ? Object.assign(current, found) : found;
}
export function terminalChunk(previous, result, requestedOffset) {
  const chunk = result.output || '';
  const next = Number.isFinite(result.nextOffsetChars) ? result.nextOffsetChars : requestedOffset + chunk.length;
  // A truncated remote buffer is a discontinuity; do not join unrelated ranges.
  const contiguous = previous && !result.truncated && previous.offset === requestedOffset;
  return { offset: next, text: ((contiguous ? previous.text : '') + chunk).slice(-TERMINAL_LIMIT) };
}
export function terminalText(text) {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
export function parseJobs(output) {
  return String(output || '').split('\n').flatMap(line => {
    const match = /^(job-[\w-]+)\s+(running|starting|exited|killed|lost)(?:\s+\(exit (-?\d+)\))?\s*(.*)$/.exec(line.trim());
    return match ? [{id:match[1],state:match[2],exitCode:match[3]===undefined?undefined:Number(match[3]),command:match[4]}] : [];
  });
}
