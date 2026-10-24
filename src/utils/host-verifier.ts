import fs from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function knownHostVerifier(file: string, hostname: string): (key: Buffer) => boolean {
  const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  return key => {
    let accepted = false;
    for (const line of records) {
      const parts = line.trim().split(/\s+/);
      const marker = parts[0]?.startsWith('@') ? parts.shift() : undefined;
      const [hosts, , encoded] = parts;
      if (!hosts || !encoded || hosts.startsWith('#')) continue;
      const match = hosts.split(',').some(host => {
        if (host === hostname) return true;
        if (!host.startsWith('|1|')) return false;
        const [, , salt, hash] = host.split('|');
        if (!salt || !hash) return false;
        const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(hostname).digest();
        const expected = Buffer.from(hash, 'base64');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
      const saved = Buffer.from(encoded, 'base64');
      if (!match || saved.length !== key.length || !timingSafeEqual(saved, key)) continue;
      if (marker === '@revoked') return false;
      if (!marker) accepted = true;
    }
    return accepted;
  };
}
