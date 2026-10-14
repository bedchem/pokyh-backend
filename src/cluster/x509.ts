import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto';

// Node certificates for the mutually authenticated cluster channel (mtls.ts).
// Pure, with no dependency beyond Node itself, so it is tested on its own
// (tests/clusterX509).
//
// Every node holds one self-signed ECDSA P-256 certificate. Nothing about it
// is trusted because of who signed it: peers pin each other's public key
// (SHA-256 over the SubjectPublicKeyInfo, the format `curl --pinnedpubkey`
// uses), exchange the pins only over authenticated paths (pairing, an
// introduction by a common peer, the one-line installer's token), and refuse
// everything else. There is no certificate authority whose key could be
// stolen, and removing a peer revokes it at once.
//
// Node's crypto module can parse certificates but not create them, so the few
// DER structures a certificate needs are encoded here (RFC 5280).

const OID_EC_PUBLIC_KEY_SHA256_SIGNATURE = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

// Longest PEM a peer may hand over; ours are well under 1 KiB.
export const MAX_CERTIFICATE_PEM_LENGTH = 4096;

// ─── DER ─────────────────────────────────────────────────────────────────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (tag: number, content: Buffer): Buffer => tlv(0xa0 | tag, content);
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const bitString = (bytes: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const TRUE = tlv(0x01, Buffer.from([0xff]));

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) encoded.unshift((value & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

// A non-negative INTEGER from big-endian bytes.
function unsignedInteger(bytes: Buffer): Buffer {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1);
  if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

// RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050 on; whole seconds.
function time(date: Date): Buffer {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`, 'ascii'));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? sequence(oid(id), TRUE, octetString(value)) : sequence(oid(id), octetString(value));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ─── Certificates ────────────────────────────────────────────────────────────

export interface NodeCertificate {
  certPem: string;
  keyPem: string;
  pin: string;
  notAfter: Date;
}

function uncompressedPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
}

// A fresh key pair and a self-signed certificate for it. The certificate is a
// plain end-entity certificate usable for both ends of a TLS connection.
export function createNodeCertificate(commonName: string, validDays = 3650, now = new Date()): NodeCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // Tolerates a peer whose clock is somewhat behind.
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + validDays * 24 * 60 * 60 * 1000);
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const signatureAlgorithm = sequence(oid(OID_EC_PUBLIC_KEY_SHA256_SIGNATURE));
  const subject = name(commonName.slice(0, 64));

  const tbs = sequence(
    explicit(0, unsignedInteger(Buffer.from([2]))),
    unsignedInteger(serial),
    signatureAlgorithm,
    subject,
    sequence(time(notBefore), time(notAfter)),
    subject,
    spki,
    explicit(3, sequence(
      extension(OID_BASIC_CONSTRAINTS, true, sequence()),
      // digitalSignature only.
      extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
      extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH), oid(OID_CLIENT_AUTH))),
      extension(OID_SUBJECT_KEY_IDENTIFIER, false, octetString(createHash('sha1').update(uncompressedPoint(publicKey)).digest())),
    )),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, signatureAlgorithm, bitString(signature));
  const certPem = pem('CERTIFICATE', der);
  return {
    certPem,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pin: certificatePin(certPem),
    notAfter,
  };
}

// SHA-256 over the certificate's SubjectPublicKeyInfo, base64 — the value
// `curl --pinnedpubkey sha256//…` expects. It stays the same if a certificate
// is re-issued for the same key.
export function certificatePin(certificate: string | Buffer | X509Certificate): string {
  const x509 = certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate);
  return createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

export const PIN_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface CertificateFacts {
  pin: string;
  pem: string;
  notBefore: Date;
  notAfter: Date;
}

// Accepts a certificate a peer handed over only if it is what this code
// produces: a self-signed P-256 certificate within its validity period.
// Throws with a reason otherwise.
export function inspectNodeCertificate(certPem: string, now = new Date()): CertificateFacts {
  if (typeof certPem !== 'string' || certPem.length > MAX_CERTIFICATE_PEM_LENGTH) throw new Error('certificate is missing or too long');
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch {
    throw new Error('certificate cannot be parsed');
  }
  const key = x509.publicKey;
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('certificate does not carry a P-256 key');
  }
  if (!x509.verify(key)) throw new Error('certificate is not validly self-signed');
  const notBefore = new Date(x509.validFrom);
  const notAfter = new Date(x509.validTo);
  if (!(notBefore.getTime() <= now.getTime() + 24 * 60 * 60 * 1000) || !(notAfter.getTime() > now.getTime())) {
    throw new Error('certificate is outside its validity period');
  }
  return { pin: certificatePin(x509), pem: x509.toString(), notBefore, notAfter };
}
