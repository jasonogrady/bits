/* ============================================================
   Web Push sender for Cloudflare Workers — zero dependencies.
   Implements VAPID (RFC 8292, ES256 JWT) and message encryption
   (RFC 8291 / RFC 8188, aes128gcm) with WebCrypto.

   Requires on env:
     VAPID_PUBLIC_KEY   — base64url uncompressed P-256 point (wrangler.toml [vars])
     VAPID_PRIVATE_JWK  — JSON JWK of the private key (Pages secret)
   ============================================================ */

const te = new TextEncoder();

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64u(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  );
  return new Uint8Array(bits);
}

async function vapidJwt(env, endpointOrigin) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const header = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(te.encode(JSON.stringify({
    aud: endpointOrigin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:jason@ogrady.ai',
  })));
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA emits raw r||s (64 bytes) — exactly the JWS format.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)
  );
  return `${signingInput}.${bytesToB64u(sig)}`;
}

/* RFC 8291 encryption: returns the aes128gcm body (header block + ciphertext). */
async function encryptPayload(payload, p256dhB64u, authB64u) {
  const uaPublic = b64uToBytes(p256dhB64u);       // 65-byte uncompressed point
  const authSecret = b64uToBytes(authB64u);        // 16 bytes

  const asKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', asKeys.publicKey)
  );
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, asKeys.privateKey, 256
  ));

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, "WebPush: info" || 0x00 || ua_pub || as_pub)
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 delimiter (last record)
  const record = concat(te.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, record
  ));

  // aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Send one Web Push notification.
 * @param env       Pages env (VAPID_* present)
 * @param sub       {endpoint, keys: {p256dh, auth}}
 * @param payload   string (JSON) delivered to the service worker
 * @returns {status, gone} — gone=true means the subscription is dead (delete it)
 */
export async function sendWebPush(env, sub, payload, urgency = 'high') {
  const endpoint = sub.endpoint;
  const origin = new URL(endpoint).origin;
  const [jwt, body] = await Promise.all([
    vapidJwt(env, origin),
    encryptPayload(payload, sub.keys.p256dh, sub.keys.auth),
  ]);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
