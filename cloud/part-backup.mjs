export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

const RPC_PREFIX = 'autoreport_part_backup_';
const CODE_PREFIX = 'ARP1';
const FORMAT_VERSION = 1;
const CHUNK_BYTES = 256 * 1024;
const MAX_CHUNK_CHARS = 4 * Math.ceil(CHUNK_BYTES / 3);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES;
const MAX_CIPHERTEXT_BYTES = MAX_BACKUP_BYTES + HEADER_BYTES + TAG_BYTES;
const MAX_CHUNKS = Math.ceil(MAX_CIPHERTEXT_BYTES / CHUNK_BYTES);
const encoder = new TextEncoder();

function webCrypto() {
  if (!globalThis.crypto?.subtle) throw Error('加密備份需要安全的 HTTPS 網頁與支援 Web Crypto 的瀏覽器。');
  return globalThis.crypto;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateRecoveryCode() {
  const secret = webCrypto().getRandomValues(new Uint8Array(32));
  return CODE_PREFIX + '-' + hex(secret).toUpperCase().match(/.{8}/g).join('-');
}

function recoverySecret(code) {
  const compact = typeof code === 'string' ? code.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^ARP1[0-9A-F]{64}$/.test(compact)) throw Error('復原碼格式不正確，請輸入完整的 ARP1 復原碼。');
  return Uint8Array.from(compact.slice(CODE_PREFIX.length).match(/../g), pair => Number.parseInt(pair, 16));
}

async function derive(crypto, secret, purpose) {
  const prefix = encoder.encode(`AutoReport-Part backup v1\0${purpose}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix);
  input.set(secret, prefix.length);
  return crypto.subtle.digest('SHA-256', input);
}

function encryptionParameters(iv, revision, context) {
  const scope = context ? '\0report\0' + context : '';
  const additionalData = encoder.encode(`AutoReport-Part backup v${FORMAT_VERSION}\0revision\0${revision}` + scope);
  return {name: 'AES-GCM', iv, additionalData, tagLength: TAG_BYTES * 8};
}

function readHead(value) {
  const {revision, chunks, updated_at} = value || {};
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isInteger(chunks) || chunks < 0 ||
      chunks > MAX_CHUNKS || (revision === 0) !== (chunks === 0) ||
      (updated_at != null && typeof updated_at !== 'string')) {
    throw Error('雲端回傳的備份版本資料無效。');
  }
  return {revision, chunks, updated_at: updated_at ?? null};
}

async function backupBytes(encoded) {
  const size = encoded instanceof Blob ? encoded.size : encoded instanceof Uint8Array ? encoded.byteLength : 0;
  if (size < 1 || size > MAX_BACKUP_BYTES) throw Error('備份內容必須介於 1 byte 與 50 MiB。');
  return encoded instanceof Blob ? new Uint8Array(await encoded.arrayBuffer()) : encoded;
}

function encodeChunk(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

function decodeChunk(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > MAX_CHUNK_CHARS || encoded.length % 4) {
    throw Error('雲端備份分段格式無效。');
  }
  let binary;
  try { binary = atob(encoded); }
  catch { throw Error('雲端備份分段格式無效。'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function partBackupCapability(code) {
  return hex(new Uint8Array(await derive(webCrypto(), recoverySecret(code), 'cloud-capability')));
}

export async function createPartBackupClient({code, request, context = ''}) {
  if (typeof request !== 'function') throw Error('缺少雲端備份連線。');
  const crypto = webCrypto();
  const secret = recoverySecret(code);
  const [tokenBytes, keyBytes] = await Promise.all([
    derive(crypto, secret, 'cloud-capability'),
    derive(crypto, secret, 'snapshot-key')
  ]);
  const token = hex(new Uint8Array(tokenBytes));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const rpc = (operation, params = {}) => request(RPC_PREFIX + operation, {p_token: token, ...params});
  const head = async () => readHead(await rpc('head'));

  async function upload(encoded, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw Error('請先讀取雲端備份版本，再上傳。');
    }
    const bytes = await backupBytes(encoded);
    const revision = expectedRevision + 1;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt(encryptionParameters(iv, revision, context), key, bytes);
    const payload = new Uint8Array(HEADER_BYTES + sealed.byteLength);
    payload[0] = FORMAT_VERSION;
    payload.set(iv, 1);
    payload.set(new Uint8Array(sealed), HEADER_BYTES);
    const count = Math.ceil(payload.length / CHUNK_BYTES);
    const uploadId = await rpc('begin', {p_revision: expectedRevision, p_chunks: count});
    if (typeof uploadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw Error('雲端回傳的上傳識別碼無效。');
    }

    try {
      for (let index = 0; index < count; index++) {
        const offset = index * CHUNK_BYTES;
        const chunk = encodeChunk(payload.subarray(offset, offset + CHUNK_BYTES));
        await rpc('put', {p_upload: uploadId, p_index: index, p_data: chunk});
      }
      const committed = readHead(await rpc('commit', {p_upload: uploadId}));
      if (committed.revision !== revision || committed.chunks !== count) throw Error('雲端確認的備份版本與本次上傳不同。');
      return revision;
    } catch (error) {
      try { await rpc('abort', {p_upload: uploadId}); } catch { /* Preserve the upload error. */ }
      throw error;
    }
  }

  async function download(expectedRevision) {
    const {revision, chunks} = await head();
    if (expectedRevision !== undefined && revision !== expectedRevision) throw Error('雲端備份版本已變更，請重新查詢。');
    if (!revision) throw Error('此復原碼沒有可下載的雲端備份。');
    const payload = new Uint8Array(Math.min(chunks * CHUNK_BYTES, MAX_CIPHERTEXT_BYTES));
    let length = 0;
    for (let index = 0; index < chunks; index++) {
      const bytes = decodeChunk(await rpc('get', {p_revision: revision, p_index: index}));
      if (!bytes.length || bytes.length > CHUNK_BYTES || length + bytes.length > payload.length ||
          (index < chunks - 1 && bytes.length !== CHUNK_BYTES)) throw Error('雲端備份分段大小無效。');
      payload.set(bytes, length);
      length += bytes.length;
    }
    if (payload[0] !== FORMAT_VERSION || length <= HEADER_BYTES + TAG_BYTES) throw Error('雲端備份格式不支援或檔案不完整。');
    const iv = payload.subarray(1, HEADER_BYTES);
    let plaintext;
    try { plaintext = await crypto.subtle.decrypt(encryptionParameters(iv, revision, context), key, payload.subarray(HEADER_BYTES, length)); }
    catch { throw Error('無法驗證或解密此備份，請確認復原碼與備份完整性。'); }
    return new Blob([plaintext], {type: 'application/json'});
  }

  return {head, upload, download};
}
