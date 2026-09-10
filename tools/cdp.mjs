// Minimal Chrome DevTools Protocol client (no dependencies).
// Talks to a Chrome/Edge instance started with --remote-debugging-port.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
      });
    }).on('error', reject);
  });
}

export async function waitForTargets(port, timeoutMs = 30000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(list)) return list;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out waiting for CDP: ' + (lastErr && lastErr.message));
}

/** Very small RFC6455 client: text frames, no fragmentation, handles 16/64-bit lengths. */
export class WS extends EventEmitter {
  constructor(url) {
    super();
    this.on('error', () => {}); // never let socket teardown crash the harness
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    const u = new URL(url);
    this.key = crypto.randomBytes(16).toString('base64');
    const req =
      `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
      `Host: ${u.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const socket = (this.socket = net.connect(Number(u.port) || 80, u.hostname));
    this.ready = new Promise((resolve, reject) => {
      let handshakeDone = false;
      socket.on('connect', () => socket.write(req));
      socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshakeDone) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.subarray(0, idx).toString('latin1');
          this.buf = this.buf.subarray(idx + 4);
          if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('bad handshake: ' + head.split('\r\n')[0]));
          const accept = crypto.createHash('sha1')
            .update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          if (!head.includes(accept)) return reject(new Error('bad Sec-WebSocket-Accept'));
          handshakeDone = true;
          resolve();
        }
        this.drain();
      });
      socket.on('error', (e) => (handshakeDone ? this.emit('error', e) : reject(e)));
      socket.on('close', () => this.emit('close'));
    });
  }

  drain() {
    while (true) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (mask) { const c = Buffer.from(payload); for (let i = 0; i < c.length; i++) c[i] ^= mask[i & 3]; payload = c; }
      this.buf = b.subarray(off + len);

      if (op === 0x8) { this.socket.end(); this.emit('close'); return; }
      if (op === 0x9) { this.sendFrame(payload, 0xa); continue; }
      if (op === 0xa) continue;
      if (op === 0x0) this.frag.push(payload);
      else { this.frag = [payload]; this.fragOp = op; }
      if (fin) {
        const data = Buffer.concat(this.frag);
        this.frag = [];
        if (this.fragOp === 0x1) this.emit('message', data.toString('utf8'));
        else if (this.fragOp === 0x2) this.emit('binary', data);
      }
    }
  }

  sendFrame(payload, op = 0x1) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(6); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(8); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(14); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | op;
    const mask = crypto.randomBytes(4);
    mask.copy(header, header.length - 4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, body]));
  }

  send(obj) { this.sendFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1); }
  close() { try { this.socket.end(); } catch {} }
}

/** A CDP session over one page target. */
export class Session {
  constructor(ws, sessionId = null) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.on('message', (txt) => {
      let msg;
      try { msg = JSON.parse(txt); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 180000);
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error('eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

export async function connect(port, { urlIncludes = null } = {}) {
  const list = await waitForTargets(port);
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  let target = pages.find((p) => (urlIncludes ? p.url.includes(urlIncludes) : true));
  if (!target) throw new Error('no page target; got: ' + JSON.stringify(list.map((t) => t.type + ' ' + t.url)));
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.ready;
  const root = new Session(ws);
  root.__targetUrl = target.url;
  return { ws, root, target, browserWsUrl: target.webSocketDebuggerUrl };
}
