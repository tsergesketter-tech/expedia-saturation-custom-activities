// Journey Builder signs custom activity calls (useJwt: true) with the installed
// package's JWT Signing Secret, HS256.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function decodeJwt(token, secret) {
  const [h, p, sig] = String(token).trim().split('.');
  if (!sig) throw new Error('not a JWT');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (!secret) return { payload, verified: false };
  // The package secret is used as-is by Journey Builder; also accept its base64-decoded form.
  const keys = [Buffer.from(secret, 'utf8'), Buffer.from(secret, 'base64url')];
  const ok = keys.some((k) => {
    const expected = b64url(createHmac('sha256', k).update(`${h}.${p}`).digest());
    return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  });
  if (!ok) throw new Error('JWT signature invalid');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('JWT expired');
  return { payload, verified: true };
}
