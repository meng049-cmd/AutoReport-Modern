import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPartBackupClient, generateRecoveryCode, MAX_BACKUP_BYTES} from './part-backup.mjs';

const prefix = 'autoreport_part_backup_';
const empty = {revision: 0, chunks: 0, updated_at: null};
const snapshot = value => new Blob([JSON.stringify(value)], {type: 'application/json'});

function fakeCloud() {
  const committed = new Map();
  const uploads = new Map();
  const calls = [];
  function stateOf(token) {
    return committed.get(token)?.head || empty;
  }
  async function request(name, params) {
    assert.ok(name.startsWith(prefix));
    const operation = name.slice(prefix.length);
    const {p_token: token, p_revision: revision, p_chunks: chunks, p_upload: id,
      p_index: index, p_data: data} = params;
    assert.match(token, /^[a-f0-9]{64}$/);
    calls.push({operation, params});
    if (operation === 'head') return {...stateOf(token)};
    if (operation === 'begin') {
      if (revision !== stateOf(token).revision) throw Error('revision conflict');
      if ([...uploads.values()].some(upload => upload.token === token)) throw Error('upload in progress');
      assert.ok(chunks > 0 && chunks <= 201);
      const id = crypto.randomUUID();
      uploads.set(id, {token, revision, chunks, data: []});
      return id;
    }
    if (operation === 'get') {
      if (revision !== stateOf(token).revision) throw Error('revision conflict');
      return committed.get(token).data[index];
    }
    const upload = uploads.get(id);
    assert.equal(upload.token, token);
    if (operation === 'put') {
      assert.equal(index, upload.data.length);
      assert.ok(data.length > 0 && data.length <= 350000);
      assert.equal(data.length % 4, 0);
      assert.match(data, /^[A-Za-z0-9+/]+={0,2}$/);
      upload.data.push(data);
    } else if (operation === 'commit') {
      if (upload.revision !== stateOf(token).revision) throw Error('revision conflict');
      assert.equal(upload.data.length, upload.chunks);
      const head = {revision: upload.revision + 1, chunks: upload.chunks, updated_at: new Date().toISOString()};
      committed.set(token, {head, data: upload.data});
      uploads.delete(id);
      return head;
    } else if (operation === 'abort') {
      uploads.delete(id);
    } else {
      throw Error('unknown operation: ' + operation);
    }
  }
  return {calls, committed, uploads, request};
}

test('a recovery code restores an encrypted multi-chunk backup on a second client', async () => {
  const code = generateRecoveryCode();
  assert.match(code, /^ARP1(?:-[A-F0-9]{8}){8}$/);
  assert.notEqual(code, generateRecoveryCode());
  const server = fakeCloud();
  const source = await createPartBackupClient({code, request: server.request});
  assert.deepEqual(await source.head(), empty);
  const original = snapshot({description: '料號查找與品質分析', data: 'x'.repeat(530000)});
  assert.equal(await source.upload(original, 0), 1);
  const freshClient = await createPartBackupClient({code: ` ${code.toLowerCase().replaceAll('-', ' ')} `, request: server.request});
  const head = await freshClient.head();
  assert.equal(head.revision, 1);
  assert.equal(head.chunks, 3);
  const restored = await freshClient.download(head.revision);
  assert.equal(restored.type, 'application/json');
  assert.equal(await restored.text(), await original.text());

  for (const {params} of server.calls) {
    assert.equal(JSON.stringify(params).includes(code), false);
    assert.notEqual(params.p_token, code.slice(5).replaceAll('-', '').toLowerCase());
  }
  const saved = [...server.committed.values()][0];
  assert.equal(Buffer.from(saved.data[0], 'base64').includes(Buffer.from('料號查找與品質分析')), false);
  const firstIV = Buffer.from(saved.data[0], 'base64').subarray(1, 13);
  assert.equal(await source.upload(original, 1), 2);
  const secondIV = Buffer.from([...server.committed.values()][0].data[0], 'base64').subarray(1, 13);
  assert.notDeepEqual(firstIV, secondIV);
  await assert.rejects(freshClient.download(1), /版本已變更/);
});

test('a competing or stale write cannot replace a newer backup', async () => {
  const code = generateRecoveryCode();
  const server = fakeCloud();
  let signalPut, releasePut;
  const putStarted = new Promise(resolve => { signalPut = resolve; });
  const putReleased = new Promise(resolve => { releasePut = resolve; });
  const delayed = await createPartBackupClient({code, async request(name, params) {
    if (name === prefix + 'put') { signalPut(); await putReleased; }
    return server.request(name, params);
  }});
  const writing = delayed.upload(snapshot({version: 'new'}), 0);
  await putStarted;
  const other = await createPartBackupClient({code, request: server.request});
  try { await assert.rejects(other.upload(snapshot({version: 'concurrent'}), 0), /upload in progress/); }
  finally { releasePut(); }
  assert.equal(await writing, 1);
  assert.equal(server.uploads.size, 0);
  await assert.rejects(other.upload(snapshot({version: 'stale'}), 0), /revision conflict/);
  assert.deepEqual(JSON.parse(await (await other.download()).text()), {version: 'new'});
});

test('malformed codes, oversized snapshots and interrupted uploads are refused', async () => {
  const code = generateRecoveryCode();
  const server = fakeCloud();
  await assert.rejects(createPartBackupClient({code: 'ARP1-ABCD', request: server.request}), /復原碼格式/);
  const client = await createPartBackupClient({code, async request(name, params) {
    if (name === prefix + 'put' && params.p_index === 1) throw Error('interrupted');
    return server.request(name, params);
  }});
  await assert.rejects(client.upload(snapshot({})), /請先讀取/);
  await assert.rejects(client.upload(new Uint8Array(MAX_BACKUP_BYTES + 1), 0), /50 MiB/);
  assert.equal(server.calls.length, 0);
  await assert.rejects(client.upload(snapshot('x'.repeat(300000)), 0), /interrupted/);
  assert.equal(server.uploads.size, 0);
  assert.equal(server.calls.filter(({operation}) => operation === 'abort').length, 1);
  assert.deepEqual(await client.head(), empty);
  await assert.rejects(client.download(), /沒有可下載/);
});

test('an unconfirmed commit checks the same upload before reporting an unknown outcome', async () => {
  const server = fakeCloud();
  const attempts = [];
  const client = await createPartBackupClient({code: generateRecoveryCode(), async request(name, params) {
    if (name === prefix + 'commit') {
      attempts.push(params.p_upload);
      throw new DOMException('response timed out', 'TimeoutError');
    }
    return server.request(name, params);
  }});
  await assert.rejects(client.upload(snapshot({report: true}), 0), /未能確認這次上傳是否完成/);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(server.uploads.size, 0);
  assert.deepEqual(await client.head(), empty);
});

test('a wrong code, modified ciphertext or replayed ciphertext cannot be restored', async () => {
  const code = generateRecoveryCode();
  const server = fakeCloud();
  const source = await createPartBackupClient({code, request: server.request});
  await source.upload(snapshot({secret: 'contents'}), 0);
  const [token, saved] = [...server.committed.entries()][0];
  const wrongCode = generateRecoveryCode();
  const wrong = await createPartBackupClient({code: wrongCode, request: server.request});
  await assert.rejects(wrong.download(), /沒有可下載/);
  // Even if storage returns another recovery code's ciphertext, its key cannot decrypt it.
  const wrongKeyWithCiphertext = await createPartBackupClient({code: wrongCode, request: (name, params) =>
    server.request(name, {...params, p_token: token})});
  await assert.rejects(wrongKeyWithCiphertext.download(), /無法驗證或解密/);

  const original = saved.data[0];
  const bytes = Buffer.from(original, 'base64');
  bytes[bytes.length - 1] ^= 1;
  saved.data[0] = bytes.toString('base64');
  await assert.rejects(source.download(), /無法驗證或解密/);
  saved.data[0] = original;
  saved.head.revision = 2;
  await assert.rejects(source.download(2), /無法驗證或解密/);
});

test('ciphertext for one analysis report cannot be restored as a different report', async () => {
  const code = generateRecoveryCode();
  const server = fakeCloud();
  const context = crypto.randomUUID();
  const client = await createPartBackupClient({code, request: server.request, context});
  const report = snapshot({id: context});
  await client.upload(report, 0);
  assert.equal(await (await client.download()).text(), await report.text());
  const other = await createPartBackupClient({code, request: server.request, context: crypto.randomUUID()});
  await assert.rejects(other.download(), /無法驗證或解密/);
});
