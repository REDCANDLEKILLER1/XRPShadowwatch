#!/usr/bin/env node
'use strict';
// Entirely offline: the production transport sees an injected S3 client and
// command constructors. These tests establish our requests/failure behavior,
// not live R2 concurrency capability or an account's permissions.
const assert = require('assert/strict');
const P = require('../src/db/bounded-object-provider');
const B = value => Buffer.from(value);
const key = suffix => P.PREFIX + suffix;
const root = P.ROOT_KEY;
let assertions = 0;
const checks = async (name, run) => { await run(); assertions++; console.log('PASS ' + name); };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const commands = {
  GetObjectCommand: class GetObjectCommand { constructor(input) { this.input = input; } },
  PutObjectCommand: class PutObjectCommand { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class ListObjectsV2Command { constructor(input) { this.input = input; } }
};
const env = extra => ({
  SHADOWWATCH_BOUNDED_STORAGE_MODE: 'r2',
  SHADOWWATCH_BOUNDED_R2_BUCKET: 'bounded-offline-fixture',
  SHADOWWATCH_BOUNDED_R2_ENDPOINT: 'https://' + '0'.repeat(32) + '.r2.cloudflarestorage.com',
  ...extra
});
const missing = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
const conflict = () => Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
function fakeR2(extra = {}) {
  const objects = new Map(); const calls = [];
  const client = { async send(command) {
    const input = command.input, operation = command.constructor.name;
    calls.push({ operation, input });
    assert.equal(input.Bucket, 'bounded-offline-fixture');
    if (extra.before) await extra.before(operation, input, objects);
    if(operation==='ListObjectsV2Command')return {IsTruncated:false,Contents:[...objects].map(([Key,v])=>({Key,Size:v.bytes.length,ETag:v.etag}))};
    if (operation === 'GetObjectCommand') {
      const entry = objects.get(input.Key);
      if (!entry) throw missing();
      const result = { Body: Buffer.from(entry.bytes), ContentLength: entry.bytes.length,
        ETag: entry.etag, Metadata: { sha256: P.sha256(entry.bytes) } };
      return extra.read ? extra.read(result, input) : result;
    }
    assert.equal(operation, 'PutObjectCommand', 'only GetObject and PutObject exist');
    assert(Buffer.isBuffer(input.Body));
    assert.equal(input.ContentLength, input.Body.length);
    assert.equal(input.Metadata.sha256, P.sha256(input.Body));
    assert.equal(input.CacheControl, 'no-store');
    assert.equal(input.ContentMD5, require('crypto').createHash('md5').update(input.Body).digest('base64'));
    assert.equal(Object.hasOwn(input, 'IfMatch') !== Object.hasOwn(input, 'IfNoneMatch'), true);
    const prior = objects.get(input.Key);
    if (input.IfNoneMatch !== undefined) { assert.equal(input.IfNoneMatch, '*'); if (prior) throw conflict(); }
    else if (!prior || input.IfMatch !== prior.etag) throw conflict();
    const etag = '"' + P.sha256(input.Body) + '"';
    objects.set(input.Key, { bytes: Buffer.from(input.Body), etag });
    if (extra.afterPut) return extra.afterPut(input, objects);
    return { ETag: etag };
  } };
  return { provider: P.createR2Provider({ env: env(), client, commands, ...extra.options }), objects, calls, client };
}
async function contract(factory) {
  const p = factory(), object = key('active/objects/payload.json');
  assert.equal(await p.get(object), null); assert.equal(await p.getVersioned(root), null);
  const value = B('{"revision":1}'), original = Buffer.from(value);
  const first = await p.putImmutable(object, value); value.fill(0);
  assert.deepEqual(await p.get(object), original);
  assert.equal(await p.putImmutable(object, original), first);
  await rejects(p.putImmutable(object, B('different')), 'BOUNDED_IMMUTABLE_COLLISION');
  const read = await p.getVersioned(object); assert.equal(read.etag, first); read.bytes.fill(0);
  assert.deepEqual(await p.get(object), original);
  await rejects(p.compareAndSwap(root, '"unknown"', B('root')), 'BOUNDED_CAS_CONFLICT');
  const rev1 = await p.compareAndSwap(root, null, B('{"revision":1}'));
  await rejects(p.compareAndSwap(root, null, B('reset')), 'BOUNDED_CAS_CONFLICT');
  const rev2 = await p.compareAndSwap(root, rev1, B('{"revision":2}'));
  await rejects(p.compareAndSwap(root, rev1, B('stale')), 'BOUNDED_CAS_CONFLICT');
  assert.notEqual(rev1, rev2);
  const outcomes = await Promise.allSettled([
    p.compareAndSwap(root, rev2, B('{"revision":3,"writer":"a"}')),
    p.compareAndSwap(root, rev2, B('{"revision":3,"writer":"b"}'))
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const loser = outcomes.find(x => x.status === 'rejected').reason;
  assert.equal(loser.code, 'BOUNDED_CAS_CONFLICT'); assert.equal(loser.casConflict, true);
  for (const invalid of ['elsewhere/root.json', key('../archive.json'), key('a//b'), key('./a'), key('a/'), key('%2e%2e/a'), key('x?y'), key('x\\y'), '']) {
    await rejects(p.get(invalid), 'BOUNDED_KEY_INVALID');
    await rejects(p.putImmutable(invalid, B('x')), 'BOUNDED_KEY_INVALID');
    await rejects(p.compareAndSwap(invalid, null, B('x')), 'BOUNDED_KEY_INVALID');
  }
  await rejects(p.putImmutable(root, B('bad')), 'BOUNDED_ROOT_REQUIRES_CAS');
  await rejects(p.compareAndSwap(object, first, B('bad')), 'BOUNDED_CAS_ROOT_ONLY');
  for (const invalid of ['*', 'W/"weak"', '"one", "two"', '"a"\r\nx-header: ignored', undefined]) {
    await rejects(p.compareAndSwap(root, invalid, B('bad')), 'BOUNDED_ETAG_INVALID');
  }
  await rejects(p.putImmutable(key('plain-object'), {}), 'BOUNDED_BYTES_REQUIRED');
  assert.equal(p.delete, undefined); assert.equal(typeof p.list, 'function'); assert(Object.isFrozen(p));
}
(async () => {
  await checks('memory and R2 expose matching immutable Buffer/CAS contract', async () => {
    await contract(() => P.createMemoryProvider());
    await contract(() => fakeR2().provider);
  });
  await checks('current-key inventory is read-only, paginated and fail-closed', async () => {
    const m=P.createMemoryProvider({now:()=>0,identity:{account:'a',bucket:'b'}});
    await m.putImmutable(key('objects/a'),B('a'));await m.compareAndSwap(root,null,B('r'));
    const listing=await m.list();assert.equal(listing.length,2);assert.equal(listing[0].last_modified,'1970-01-01T00:00:00.000Z');
    assert.deepEqual(m.identity,{backend:'memory',account:'a',bucket:'b',prefix:P.PREFIX});assert(Object.isFrozen(m.identity));
    const fixture=fakeR2();await fixture.provider.putImmutable(key('objects/a'),B('a'));
    assert.equal((await fixture.provider.list()).length,1);
    const make=pages=>P.createR2Provider({env:env(),commands,client:{send:async command=>{assert(command instanceof commands.ListObjectsV2Command);return pages.shift();}}});
    const item={Key:key('objects/a'),Size:1,ETag:'"a"'};
    assert.equal((await make([{IsTruncated:true,Contents:[item],NextContinuationToken:'next'},{IsTruncated:false,Contents:[{...item,Key:key('objects/b')}]}]).list()).length,2);
    for(const pages of [[{IsTruncated:false,Contents:null}],[{IsTruncated:false,Contents:[],KeyCount:1}],[{IsTruncated:false,Contents:[],Prefix:'elsewhere/'}],[{IsTruncated:false,Contents:[],CommonPrefixes:[{Prefix:key('objects/')}] }],[{IsTruncated:false,Contents:[],NextContinuationToken:'unexpected'}],[{IsTruncated:true,Contents:[]}],[{IsTruncated:false,Contents:[item,item]}],[{IsTruncated:false,Contents:[{...item,Key:'outside/a'}]}],[{Contents:[]}],[{IsTruncated:true,Contents:[],NextContinuationToken:'same'},{IsTruncated:true,Contents:[],NextContinuationToken:'same'}]])await assert.rejects(make(pages).list(),/BOUNDED_/);
  });
  await checks('preview and development cannot write even with configured credentials', async () => {
    for(const VERCEL_ENV of ['preview','development']) {
      const fixture=fakeR2({options:{env:env({VERCEL_ENV})}});
      await rejects(fixture.provider.putImmutable(key('objects/preview'),B('no write')),'BOUNDED_PREVIEW_WRITE_REFUSED');
      await rejects(fixture.provider.compareAndSwap(root,null,B('no write')),'BOUNDED_PREVIEW_WRITE_REFUSED');
      assert.equal(fixture.calls.length,0);
    }
  });
  await checks('default-disabled configuration and production capability guard', async () => {
    assert.throws(() => P.createR2Provider({ env: {} }), /BOUNDED_STORAGE_DISABLED/);
    for (const mode of ['github', 'memory', 'true', 'R2']) {
      assert.throws(() => P.createR2Provider({ env: env({ SHADOWWATCH_BOUNDED_STORAGE_MODE: mode }) }), /BOUNDED_STORAGE_DISABLED/);
    }
    for (const production of [{ NODE_ENV: 'production' }, { VERCEL_ENV: 'production' }]) {
      assert.throws(() => P.createR2Provider({ env: env(production) }), /BOUNDED_PRODUCTION_CAS_NOT_VERIFIED/);
      assert.throws(() => P.createR2Provider({ env: env({ ...production, SHADOWWATCH_BOUNDED_CAS_VERIFIED: 'yes' }) }), /BOUNDED_PRODUCTION_CAS_NOT_VERIFIED/);
      assert.equal(P.createR2Provider({ env: env({ ...production, SHADOWWATCH_BOUNDED_CAS_VERIFIED: 'true' }), commands, client: { send() { throw Error('no network'); } } }).kind, 'r2');
    }
    for (const bucket of [undefined, '', 'ShadowWatch', 'shadowwatch-backups']) {
      assert.throws(() => P.createR2Provider({ env: env({ SHADOWWATCH_BOUNDED_R2_BUCKET: bucket }) }), /BOUNDED_(ACTIVE_BUCKET_REQUIRED|ARCHIVE_BUCKET_FORBIDDEN)/);
    }
    assert.throws(() => P.createR2Provider({ env: env({ R2_BACKUP_BUCKET: 'bounded-offline-fixture' }) }), /BOUNDED_ARCHIVE_BUCKET_FORBIDDEN/);
    for (const endpoint of ['https://s3.amazonaws.com', 'https://user:pass@' + '0'.repeat(32) + '.r2.cloudflarestorage.com', env().SHADOWWATCH_BOUNDED_R2_ENDPOINT + '/bucket', 'http://' + '0'.repeat(32) + '.r2.cloudflarestorage.com']) {
      assert.throws(() => P.createR2Provider({ env: env({ SHADOWWATCH_BOUNDED_R2_ENDPOINT: endpoint }) }), /BOUNDED_R2_ENDPOINT_REQUIRED/);
    }
    assert.throws(() => P.createMemoryProvider({ prefix: 'objects/' }), /BOUNDED_PREFIX_INVALID/);
    assert.throws(() => P.createMemoryProvider({ rootKey: key('objects/saved') }), /BOUNDED_ROOT_KEY_INVALID/);
  });
  await checks('dedicated credentials only, explicit S3 config, SDK retries disabled', async () => {
    let clientConfig;
    const sdk = { ...commands, S3Client: class { constructor(config) { clientConfig = config; } send() { throw Error('offline'); } } };
    assert.throws(() => P.createR2Provider({ env: env({ R2_ACCESS_KEY_ID: 'existing-archive-fixture', R2_SECRET_ACCESS_KEY: 'existing-archive-fixture' }), commands: sdk }), /BOUNDED_DEDICATED_CREDENTIALS_REQUIRED/);
    P.createR2Provider({ env: env({ SHADOWWATCH_BOUNDED_R2_ACCESS_KEY_ID: 'dedicated-fixture', SHADOWWATCH_BOUNDED_R2_SECRET_ACCESS_KEY: 'dedicated-fixture' }), commands: sdk });
    assert.equal(clientConfig.maxAttempts, 1); assert.equal(clientConfig.region, 'auto');
    assert.equal(clientConfig.endpoint, env().SHADOWWATCH_BOUNDED_R2_ENDPOINT);
    assert.deepEqual(clientConfig.credentials, { accessKeyId: 'dedicated-fixture', secretAccessKey: 'dedicated-fixture' });
  });
  await checks('max object byte budgets enforced before reads or puts', async () => {
    const r = fakeR2({ options: { env: env({ SHADOWWATCH_BOUNDED_MAX_OBJECT_BYTES: '8' }), maxObjectBytes: 16 } });
    assert.equal(r.provider.maxObjectBytes, 8);
    for (const p of [r.provider, P.createMemoryProvider({ maxObjectBytes: 8 })]) {
      await rejects(p.putImmutable(key('big'), B('123456789')), 'BOUNDED_OBJECT_TOO_LARGE');
      await rejects(p.compareAndSwap(root, null, B('123456789')), 'BOUNDED_OBJECT_TOO_LARGE');
    }
    assert.equal(r.calls.length, 0);
    for (const value of ['0', '-1', '1.5', '01', '', String(P.MAX_OBJECT_BYTES + 1)]) {
      assert.throws(() => P.createR2Provider({ env: env({ SHADOWWATCH_BOUNDED_MAX_OBJECT_BYTES: value }), commands, client: r.client }), /BOUNDED_OBJECT_LIMIT_INVALID/);
    }
    for (const limit of [0, -1, NaN, Infinity, P.MAX_OBJECT_BYTES + 1]) assert.throws(() => P.createMemoryProvider({ maxObjectBytes: limit }), /BOUNDED_OBJECT_LIMIT_INVALID/);
  });
  await checks('missing object distinguished from denied, unavailable, or missing bucket', async () => {
    for (const error of [new Error('timeout'), Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), Object.assign(new Error('missing bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }), Object.assign(new Error('generic missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }), Object.assign(missing(), { $metadata: { httpStatusCode: 403 } })]) {
      const r = fakeR2({ before: async () => { throw error; } });
      await rejects(r.provider.get(root), 'BOUNDED_PROVIDER_READ_FAILED');
      await rejects(r.provider.putImmutable(key('data'), B('x')), 'BOUNDED_PROVIDER_READ_FAILED');
      await rejects(r.provider.compareAndSwap(root, null, B('x')), 'BOUNDED_PROVIDER_READ_FAILED');
      assert.equal(r.calls.filter(x => x.operation === 'PutObjectCommand').length, 0);
    }
    assert.equal(await fakeR2().provider.get(root), null);
  });
  await checks('concurrent immutable creations reuse identical bytes; collisions never overwrite', async () => {
    for (const factory of [() => P.createMemoryProvider(), () => fakeR2().provider]) {
      const p = factory(), same = key('same'), different = key('different');
      const tokens = await Promise.all([p.putImmutable(same, B('a')), p.putImmutable(same, B('a'))]);
      assert.equal(tokens[0], tokens[1]);
      const outcomes = await Promise.allSettled([p.putImmutable(different, B('a')), p.putImmutable(different, B('b'))]);
      assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'BOUNDED_IMMUTABLE_COLLISION');
    }
  });
  await checks('corrupt existing objects and roots fail integrity without override', async () => {
    for (const [damage, code] of [
      [r => { r.Metadata = {}; }, 'BOUNDED_OBJECT_HASH_MISSING'],
      [r => { r.Metadata.sha256 = '0'.repeat(64); }, 'BOUNDED_OBJECT_HASH_MISMATCH'],
      [r => { r.ContentLength++; }, 'BOUNDED_OBJECT_LENGTH_MISMATCH'],
      [r => { r.ContentLength = -1; }, 'BOUNDED_OBJECT_LENGTH_INVALID'],
      [r => { r.ETag = '*'; }, 'BOUNDED_ETAG_INVALID'],
      [r => { r.Body = undefined; }, 'BOUNDED_OBJECT_BODY_INVALID']
    ]) {
      let corrupt = false;
      const r = fakeR2({ read: result => { if (corrupt) damage(result); return result; } });
      const object = key('verified'); await r.provider.putImmutable(object, B('original'));
      const etag = await r.provider.compareAndSwap(root, null, B('original-root'));
      const before = r.calls.filter(x => x.operation === 'PutObjectCommand').length;
      corrupt = true;
      await rejects(r.provider.get(object), code);
      await rejects(r.provider.putImmutable(object, B('replacement')), code);
      await rejects(r.provider.compareAndSwap(root, etag, B('replacement')), code);
      assert.equal(r.calls.filter(x => x.operation === 'PutObjectCommand').length, before);
    }
  });
  await checks('stream size, truncation, corruption, and interruptions fail closed', async () => {
    let transform;
    const r = fakeR2({ read: result => transform ? transform(result) : result });
    const object = key('stream'); await r.provider.putImmutable(object, B('1234'));
    transform = result => ({ ...result, Body: (async function* () { yield B('12'); yield B('34'); })() });
    assert.equal((await r.provider.get(object)).toString(), '1234');
    transform = result => ({ ...result, Body: (async function* () { yield B('12345'); })() });
    await rejects(r.provider.get(object), 'BOUNDED_OBJECT_TOO_LARGE');
    transform = result => ({ ...result, Body: (async function* () { yield B('1'); })() });
    await rejects(r.provider.get(object), 'BOUNDED_OBJECT_LENGTH_MISMATCH');
    transform = result => ({ ...result, Body: (async function* () { yield B('0000'); })() });
    await rejects(r.provider.get(object), 'BOUNDED_OBJECT_HASH_MISMATCH');
    transform = result => ({ ...result, Body: (async function* () { throw Error('interrupted'); })() });
    await rejects(r.provider.get(object), 'BOUNDED_PROVIDER_READ_FAILED');
  });
  await checks('immutable successful PUT still requires matching independently read bytes', async () => {
    for (const missingRead of [true, false]) {
      let uploaded = false;
      const r = fakeR2({ before: (operation, input, objects) => {
        if (operation === 'GetObjectCommand' && uploaded) {
          if (missingRead) objects.delete(input.Key);
          else objects.get(input.Key).bytes = B('changed');
        }
      }, afterPut: (input, objects) => { uploaded = true; return { ETag: objects.get(input.Key).etag }; } });
      await rejects(r.provider.putImmutable(key('readback'), B('original')), missingRead ? 'BOUNDED_IMMUTABLE_READBACK_MISSING' : 'BOUNDED_IMMUTABLE_COLLISION');
    }
  });
  await checks('write response loss is uncertain, never retried or interpreted as absent', async () => {
    const r = fakeR2({ afterPut: () => { throw Error('response lost'); } });
    await rejects(r.provider.putImmutable(key('uncertain'), B('saved')), 'BOUNDED_PROVIDER_WRITE_UNCERTAIN');
    await rejects(r.provider.compareAndSwap(root, null, B('saved-root')), 'BOUNDED_PROVIDER_WRITE_UNCERTAIN');
    assert.equal(r.calls.filter(x => x.operation === 'PutObjectCommand').length, 2);
    assert.equal((await r.provider.get(root)).toString(), 'saved-root');
    assert.equal((await r.provider.get(key('uncertain'))).toString(), 'saved');
    // An explicit later immutable retry can reconcile exact existing bytes.
    await r.provider.putImmutable(key('uncertain'), B('saved'));
    assert.equal(r.calls.filter(x => x.operation === 'PutObjectCommand').length, 2);
  });
  await checks('malformed successful write response stays uncertain without automatic retry', async () => {
    const r = fakeR2({ afterPut: () => ({ ETag: '*' }) });
    await rejects(r.provider.putImmutable(key('bad-response'), B('saved')), 'BOUNDED_PROVIDER_WRITE_UNCERTAIN');
    await rejects(r.provider.compareAndSwap(root, null, B('saved-root')), 'BOUNDED_PROVIDER_WRITE_UNCERTAIN');
    assert.equal(r.calls.filter(x => x.operation === 'PutObjectCommand').length, 2);
    assert.equal((await r.provider.get(root)).toString(), 'saved-root');
  });
  await checks('memory failure injection preserves state and copies input before yielding', async () => {
    let fail = false;
    const p = P.createMemoryProvider({ fail: async () => fail ? new Error('injected') : undefined });
    const etag = await p.compareAndSwap(root, null, B('before'));
    fail = true;
    await assert.rejects(p.get(root), /injected/);
    await assert.rejects(p.compareAndSwap(root, etag, B('after')), /injected/);
    await assert.rejects(p.putImmutable(key('fail'), B('x')), /injected/);
    fail = false; assert.equal((await p.get(root)).toString(), 'before'); assert.equal(await p.get(key('fail')), null);
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const delayed = P.createMemoryProvider({ fail: operation => operation === 'putImmutable' ? waiting : undefined });
    const bytes = B('original'), pending = delayed.putImmutable(key('snapshot'), bytes);
    bytes.fill(0); release(); await pending;
    assert.equal((await delayed.get(key('snapshot'))).toString(), 'original');
  });
  console.log('PASS bounded object provider: ' + assertions + ' offline contract groups; no live backend qualification performed');
})().catch(error => { console.error(error); process.exitCode = 1; });
