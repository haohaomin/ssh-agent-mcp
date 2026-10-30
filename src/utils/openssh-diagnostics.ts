import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Separate a known native-SSH diagnostic; never filter remote stdout or arbitrary warnings. */
export class OpenSshDiagnostics extends Transform {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private longLine = false;
  private consume(text: string, final = false) {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end + 1);
      this.pending = this.pending.slice(end + 1);
      this.line(line);
      this.longLine = false;
    }
    const prefix = 'Shared connection to ';
    // Do not wait for a newline on arbitrary stderr: step protocol frames and
    // progress output may be deliberately unterminated. Only hold candidates.
    if (this.pending && (this.longLine || this.pending.length > 2048 ||
        !(prefix.startsWith(this.pending) || this.pending.startsWith(prefix)))) {
      this.push(this.pending); this.pending = ''; this.longLine = true;
    }
    if (final && this.pending) { this.line(this.pending); this.pending = ''; }
  }
  private line(line: string) {
    if (!this.longLine && /^Shared connection to [^\r\n]{1,1024} closed\.\r?\n?$/.test(line)) {
      this.emit('diagnostic', {source: 'openssh', kind: 'shared_connection_closed', message: line.trimEnd()});
    } else this.push(line);
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.consume(this.decoder.write(chunk)); callback();
  }
  _flush(callback: TransformCallback) { this.consume(this.decoder.end(), true); callback(); }
}
