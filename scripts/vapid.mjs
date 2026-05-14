// generate-vapid-keys.mjs
// 실행: node generate-vapid-keys.mjs
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const toB64Url = (buf) =>
    Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
);

// 공개키: raw 형식 (0x04 ‖ X ‖ Y, 65바이트)
const rawPublic = await subtle.exportKey('raw', keyPair.publicKey);

// 비밀키: JWK 의 d 필드 (32바이트 스칼라) 만 사용
const jwkPrivate = await subtle.exportKey('jwk', keyPair.privateKey);

console.log('VAPID_PUBLIC_KEY  =', toB64Url(rawPublic));
console.log('VAPID_PRIVATE_KEY =', jwkPrivate.d);
console.log('VAPID_SUBJECT     = mailto:admin@example.com   # 운영자 연락처로 교체');
