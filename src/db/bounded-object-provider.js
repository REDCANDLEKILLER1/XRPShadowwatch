'use strict';
// Opt-in object transport for the bounded store. Nothing in this module enables
// a production route, modifies credentials, or falls back to the GitHub archive.
// The only replaceable object is root.json; every other object is create-once.
// No delete/GC API is provided. A bounded active manifest does NOT bound the
// physical accumulation of superseded immutable objects. Production rollout
// still needs an independently reviewed capacity/retention operating policy.
//
// Conditional PUT support checked against official documentation 2026-10-13:
// https://developers.cloudflare.com/r2/api/s3/api/
// https://developers.cloudflare.com/r2/reference/consistency/
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
// These establish supported headers and direct-S3 consistency, not a live
// account qualification. In production SHADOWWATCH_BOUNDED_CAS_VERIFIED=true
// is an operator attestation: first run concurrent create/update/conflict probes
// and lost-response reconciliation in a dedicated empty isolated namespace, and
// review the resulting capability record before setting it. This patch neither
// performs that probe nor supplies that attestation. The outstanding precision
// question about concurrent conditional creation is recorded at:
// https://github.com/cloudflare/cloudflare-docs/issues/32793
// No network operation or capability probe runs until configured and called. Keep SDK retries off: a timeout may
// follow a committed write, so uncertainty must never become a blind retry.

const crypto = require('crypto');
const PREFIX = 'bounded/v1/';
const ROOT_KEY = PREFIX + 'root.json';
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const ARCHIVE_BUCKET = 'shadowwatch-backups';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fault(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  if (code === 'BOUNDED_CAS_CONFLICT') error.casConflict = true;
  return error;
}
function checkKey(key, prefix) {
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.length > 1024 ||
      !/^[a-zA-Z0-9._/-]+$/.test(key) || key.endsWith('/') ||
      key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fault('BOUNDED_KEY_INVALID');
  }
  return key;
}
function layout(options) {
  const prefix = options.prefix === undefined ? PREFIX : options.prefix;
  if (typeof prefix !== 'string' || !prefix.startsWith(PREFIX) || !prefix.endsWith('/')) {
    throw fault('BOUNDED_PREFIX_INVALID');
  }
  checkKey(prefix + 'probe', PREFIX);
  const rootKey = options.rootKey === undefined ? prefix + 'root.json' : options.rootKey;
  checkKey(rootKey, prefix);
  if (rootKey !== prefix + 'root.json') throw fault('BOUNDED_ROOT_KEY_INVALID');
  const maxObjectBytes = options.maxObjectBytes === undefined ? MAX_OBJECT_BYTES : options.maxObjectBytes;
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES) {
    throw fault('BOUNDED_OBJECT_LIMIT_INVALID');
  }
  return { prefix, rootKey, maxObjectBytes };
}
function copyBytes(bytes, maxObjectBytes) {
  if (!Buffer.isBuffer(bytes)) throw fault('BOUNDED_BYTES_REQUIRED');
  if (bytes.length > maxObjectBytes) throw fault('BOUNDED_OBJECT_TOO_LARGE');
  return Buffer.from(bytes);
}
function checkETag(etag) {
  // A single strong, quoted ETag. Wildcards, weak tags, and lists can turn CAS
  // into an unconditional replacement and therefore are never accepted.
  if (typeof etag !== 'string' || !/^"[\x21\x23-\x7e]{1,256}"$/.test(etag)) {
    throw fault('BOUNDED_ETAG_INVALID');
  }
  return etag;
}
function writeETag(result) {
  try { return checkETag(result && result.ETag); }
  catch (error) { throw fault('BOUNDED_PROVIDER_WRITE_UNCERTAIN', error); }
}
function requireEqual(existing, bytes) {
  if (!existing || existing.bytes.length !== bytes.length ||
      sha256(existing.bytes) !== sha256(bytes) || !existing.bytes.equals(bytes)) {
    throw fault('BOUNDED_IMMUTABLE_COLLISION');
  }
  return existing.etag;
}
function isMissing(error) {
  // Generic 404 / NotFound can mean a missing bucket or endpoint, not absence
  // of this object. Only the provider's explicit NoSuchKey is empty storage.
  return !!error && (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.code === 'NoSuchKey') &&
    (!error.$metadata || error.$metadata.httpStatusCode === undefined || error.$metadata.httpStatusCode === 404);
}
function isConflict(error) {
  return !!error && (error.$metadata && (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409) ||
    ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error.name) ||
    ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error.Code));
}
function config(env) {
  if (env.SHADOWWATCH_BOUNDED_STORAGE_MODE !== 'r2') throw fault('BOUNDED_STORAGE_DISABLED');
  if ((env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') &&
      env.SHADOWWATCH_BOUNDED_CAS_VERIFIED !== 'true') {
    throw fault('BOUNDED_PRODUCTION_CAS_NOT_VERIFIED');
  }
  const bucket = env.SHADOWWATCH_BOUNDED_R2_BUCKET;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw fault('BOUNDED_ACTIVE_BUCKET_REQUIRED');
  }
  if ([ARCHIVE_BUCKET, env.R2_BACKUP_BUCKET, env.SHADOWWATCH_R2_BACKUP_BUCKET].includes(bucket)) {
    throw fault('BOUNDED_ARCHIVE_BUCKET_FORBIDDEN');
  }
  const endpoint = env.SHADOWWATCH_BOUNDED_R2_ENDPOINT;
  // Only the direct R2 S3 endpoint is qualified. Custom/cache domains and other
  // "S3-compatible" implementations cannot silently inherit the CAS contract.
  if (typeof endpoint !== 'string' || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(endpoint)) {
    throw fault('BOUNDED_R2_ENDPOINT_REQUIRED');
  }
  const rawLimit = env.SHADOWWATCH_BOUNDED_MAX_OBJECT_BYTES;
  if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9][0-9]*$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) > MAX_OBJECT_BYTES)) {
    throw fault('BOUNDED_OBJECT_LIMIT_INVALID');
  }
  return { bucket, endpoint, configuredLimit: rawLimit === undefined ? MAX_OBJECT_BYTES : Number(rawLimit) };
}
async function readBytes(result, limit) {
  if (!result || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0 || result.ContentLength > limit) {
    if (result && result.Body && typeof result.Body.destroy === 'function') result.Body.destroy();
    throw fault('BOUNDED_OBJECT_LENGTH_INVALID');
  }
  if (!result.Metadata || !/^[a-f0-9]{64}$/.test(result.Metadata.sha256 || '')) {
    if (result.Body && typeof result.Body.destroy === 'function') result.Body.destroy();
    throw fault('BOUNDED_OBJECT_HASH_MISSING');
  }
  const chunks = []; let size = 0;
  try {
    const body = result.Body;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (body.length > limit) throw fault('BOUNDED_OBJECT_TOO_LARGE');
      chunks.push(Buffer.from(body)); size = body.length;
    } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw fault('BOUNDED_OBJECT_BODY_INVALID');
        size += chunk.length;
        if (size > limit || size > result.ContentLength) throw fault('BOUNDED_OBJECT_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
    } else throw fault('BOUNDED_OBJECT_BODY_INVALID');
  } catch (error) {
    if (result.Body && typeof result.Body.destroy === 'function') result.Body.destroy();
    if (error.code && error.code.startsWith('BOUNDED_')) throw error;
    throw fault('BOUNDED_PROVIDER_READ_FAILED', error);
  }
  const bytes = Buffer.concat(chunks, size);
  if (size !== result.ContentLength) throw fault('BOUNDED_OBJECT_LENGTH_MISMATCH');
  if (sha256(bytes) !== result.Metadata.sha256) throw fault('BOUNDED_OBJECT_HASH_MISMATCH');
  return bytes;
}

function createR2Provider(options = {}) {
  const env = options.env || process.env;
  const { bucket, endpoint, configuredLimit } = config(env);
  const limits = layout(options);
  const { prefix, rootKey } = limits;
  const maxObjectBytes = Math.min(limits.maxObjectBytes, configuredLimit);
  // SDK stays lazy so importing a disabled module cannot discover credentials,
  // contact any provider, or make the existing archive depend on this package.
  const sdk = options.commands || require('@aws-sdk/client-s3');
  if (typeof sdk.GetObjectCommand !== 'function' || typeof sdk.PutObjectCommand !== 'function') {
    throw fault('BOUNDED_COMMANDS_INVALID');
  }
  let client = options.client;
  if (!client) {
    const accessKeyId = env.SHADOWWATCH_BOUNDED_R2_ACCESS_KEY_ID;
    const secretAccessKey = env.SHADOWWATCH_BOUNDED_R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw fault('BOUNDED_DEDICATED_CREDENTIALS_REQUIRED');
    client = new sdk.S3Client({ endpoint, region: 'auto', maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId, secretAccessKey } });
  }
  if (!client || typeof client.send !== 'function') throw fault('BOUNDED_CLIENT_INVALID');

  async function getVersioned(key) {
    checkKey(key, prefix);
    let result;
    try { result = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key })); }
    catch (error) {
      if (isMissing(error)) return null;
      throw fault('BOUNDED_PROVIDER_READ_FAILED', error);
    }
    const bytes = await readBytes(result, maxObjectBytes);
    return { bytes, etag: checkETag(result.ETag) };
  }
  function input(key, bytes) {
    return { Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
      ContentType: 'application/octet-stream', CacheControl: 'no-store',
      ContentMD5: crypto.createHash('md5').update(bytes).digest('base64'),
      Metadata: { sha256: sha256(bytes) } };
  }
  async function putImmutable(key, value) {
    if(env.VERCEL_ENV==='preview'||env.VERCEL_ENV==='development')throw fault('BOUNDED_PREVIEW_WRITE_REFUSED');
    checkKey(key, prefix);
    if (key === rootKey) throw fault('BOUNDED_ROOT_REQUIRES_CAS');
    const bytes = copyBytes(value, maxObjectBytes);
    const existing = await getVersioned(key);
    if (existing) return requireEqual(existing, bytes);
    let result;
    try {
      result = await client.send(new sdk.PutObjectCommand({ ...input(key, bytes), IfNoneMatch: '*' }));
    } catch (error) {
      if (!isConflict(error)) throw fault('BOUNDED_PROVIDER_WRITE_UNCERTAIN', error);
      // A concurrent creator is reusable only after its bytes and SHA match.
      const winner = await getVersioned(key);
      if (!winner) throw fault('BOUNDED_IMMUTABLE_CONFLICT');
      return requireEqual(winner, bytes);
    }
    writeETag(result);
    const saved = await getVersioned(key);
    if (!saved) throw fault('BOUNDED_IMMUTABLE_READBACK_MISSING');
    if (saved.etag !== result.ETag) throw fault('BOUNDED_IMMUTABLE_READBACK_CHANGED');
    return requireEqual(saved, bytes);
  }
  async function compareAndSwap(key, expectedETag, value) {
    if(env.VERCEL_ENV==='preview'||env.VERCEL_ENV==='development')throw fault('BOUNDED_PREVIEW_WRITE_REFUSED');
    checkKey(key, prefix);
    if (key !== rootKey) throw fault('BOUNDED_CAS_ROOT_ONLY');
    if (expectedETag !== null) checkETag(expectedETag);
    const bytes = copyBytes(value, maxObjectBytes);
    // Never overwrite a malformed root merely because its ETag is known. This
    // read is integrity validation only; the following conditional PUT is the
    // atomic decision and still defeats races after this read.
    const existing = await getVersioned(key);
    if ((existing ? existing.etag : null) !== expectedETag) throw fault('BOUNDED_CAS_CONFLICT');
    let result;
    try {
      result = await client.send(new sdk.PutObjectCommand({ ...input(key, bytes),
        ...(expectedETag === null ? { IfNoneMatch: '*' } : { IfMatch: expectedETag }) }));
    } catch (error) {
      if (isConflict(error) || expectedETag !== null && isMissing(error)) throw fault('BOUNDED_CAS_CONFLICT', error);
      // Caller must reconcile using an operation/revision ID in its root.
      // No read-after-error guess, no GitHub fallback, and no force overwrite.
      throw fault('BOUNDED_PROVIDER_WRITE_UNCERTAIN', error);
    }
    return writeETag(result);
  }
  return Object.freeze({ prefix, rootKey, maxObjectBytes, kind: 'r2',
    get: async key => { const value = await getVersioned(key); return value ? value.bytes : null; },
    getVersioned, putImmutable, compareAndSwap });
}

function createMemoryProvider(options = {}) {
  const { prefix, rootKey, maxObjectBytes } = layout(options);
  const objects = new Map();
  // Test hook: fail(operation, key) may throw or return an Error, synchronously
  // or asynchronously. No hook runs between comparing and updating the Map.
  async function before(operation, key) {
    if (typeof options.fail === 'function') {
      const error = await options.fail(operation, key);
      if (error instanceof Error) throw error;
    }
  }
  async function getVersioned(key) {
    checkKey(key, prefix); await before('getVersioned', key);
    const existing = objects.get(key);
    return existing ? { bytes: Buffer.from(existing.bytes), etag: existing.etag } : null;
  }
  async function putImmutable(key, value) {
    checkKey(key, prefix);
    if (key === rootKey) throw fault('BOUNDED_ROOT_REQUIRES_CAS');
    const bytes = copyBytes(value, maxObjectBytes);
    await before('putImmutable', key);
    const existing = objects.get(key);
    if (existing) return requireEqual(existing, bytes);
    const etag = '"' + sha256(bytes) + '"';
    objects.set(key, { bytes, etag });
    return etag;
  }
  async function compareAndSwap(key, expectedETag, value) {
    checkKey(key, prefix);
    if (key !== rootKey) throw fault('BOUNDED_CAS_ROOT_ONLY');
    if (expectedETag !== null) checkETag(expectedETag);
    const bytes = copyBytes(value, maxObjectBytes);
    await before('compareAndSwap', key);
    const existing = objects.get(key);
    if ((existing ? existing.etag : null) !== expectedETag) throw fault('BOUNDED_CAS_CONFLICT');
    const etag = '"' + sha256(bytes) + '"';
    objects.set(key, { bytes, etag });
    return etag;
  }
  return Object.freeze({ prefix, rootKey, maxObjectBytes, kind: 'memory',
    get: async key => { const value = await getVersioned(key); return value ? value.bytes : null; },
    getVersioned, putImmutable, compareAndSwap });
}

module.exports = { PREFIX, ROOT_KEY, MAX_OBJECT_BYTES, ARCHIVE_BUCKET, sha256,
  createR2Provider, createProvider: createR2Provider, createMemoryProvider };
