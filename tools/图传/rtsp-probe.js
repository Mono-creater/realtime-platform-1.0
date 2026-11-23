#!/usr/bin/env node
/**
 * RTSP 探测（零依赖，不依赖 ffmpeg）：判断路径是否可用 + 编码/分辨率
 *   node rtsp-probe.js 192.168.10.88 admin 12345678a /11
 *   Git Bash 下加 MSYS_NO_PATHCONV=1，否则 /11 会被转成路径
 */
const net = require('net');
const crypto = require('crypto');

const HOST = process.argv[2] || process.env.CAM_IP || '192.168.10.88';
const USER = process.argv[3] || process.env.CAM_USER || 'admin';
const PASS = process.argv[4] || process.env.CAM_PASS || '';
const PATHS = process.argv[5] ? [process.argv[5]] : ['/11', '/12', '/ch0_0.264', '/onvif1'];

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(h) {
  const scheme = (/^(\w+)/.exec(h) || [])[1]?.toLowerCase() || '';
  const kv = {};
  for (const m of h.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) kv[m[1].toLowerCase()] = m[2] ?? m[3];
  return { scheme, ...kv };
}
function authHeader(ch, method, uri) {
  if (!ch) return null;
  if (ch.scheme === 'basic') return 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (ch.scheme !== 'digest') return null;
  const cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001';
  const ha1 = md5(`${USER}:${ch.realm}:${PASS}`), ha2 = md5(`${method}:${uri}`);
  const qop = ch.qop ? ch.qop.split(',')[0].trim() : null;
  const resp = qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [`username="${USER}"`, `realm="${ch.realm}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`, `response="${resp}"`];
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  return 'Digest ' + parts.join(', ');
}

let cseq = 0;
function req(method, url, extra = {}, auth = null) {
  return new Promise((resolve, reject) => {
    const s = net.connect(554, HOST);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 5000);
    s.on('connect', () => {
      const hdrs = Object.entries(extra).map(([k, v]) => `${k}: ${v}`);
      const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${++cseq}`, 'User-Agent: probe', ...hdrs];
      if (auth) lines.push(`Authorization: ${auth}`);
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    s.on('data', d => {
      buf += d.toString('binary');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      clearTimeout(t);
      const head = buf.slice(0, i), body = buf.slice(i + 4);
      const [statusLine, ...hl] = head.split('\r\n');
      const h = {};
      for (const l of hl) { const k = l.indexOf(':'); if (k > 0) h[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
      if (body.length >= Number(h['content-length'] || 0)) { s.destroy(); resolve({ status: Number(statusLine.split(' ')[1]), headers: h, body }); }
    });
    s.on('error', e => { clearTimeout(t); reject(e); });
  });
}

function summary(sdp) {
  if (!sdp) return '';
  const secs = []; let cur = null;
  for (const l of sdp.split(/\r?\n/)) {
    const m = /^m=(\w+) (\d+) ([\w/]+)/.exec(l);
    if (m) { cur = { kind: m[1], codec: null, res: null }; secs.push(cur); continue; }
    if (!cur) continue;
    const r = /a=rtpmap:\d+ ([^/]+)\/(\d+)/.exec(l);
    if (r && !cur.codec) cur.codec = `${r[1]}/${r[2]}`;
    const f = /a=framesize:\d+ (\d+)-(\d+)/.exec(l);
    if (f) cur.res = `${f[1]}x${f[2]}`;
  }
  return secs.map(s => [s.kind, s.codec, s.res].filter(Boolean).join(' ')).join(' | ');
}

(async () => {
  console.log(`探测 ${HOST}:554  用户 ${USER}\n`);
  let any = false;
  for (const p of PATHS) {
    const url = `rtsp://${HOST}:554${p}`;
    try {
      let r = await req('DESCRIBE', url, { Accept: 'application/sdp' });
      if (r.status === 401) {
        const ch = parseChallenge(r.headers['www-authenticate'] || '');
        const a = authHeader(ch, 'DESCRIBE', url);
        if (!a) { console.log(`  ✘ ${p.padEnd(12)} 认证方式不支持: ${ch.scheme}`); continue; }
        r = await req('DESCRIBE', url, { Accept: 'application/sdp' }, a);
      }
      if (r.status === 200) { any = true; console.log(`  ✔ ${p.padEnd(12)} 200 OK  ${summary(r.body)}`); }
      else if (r.status === 401) console.log(`  ✘ ${p.padEnd(12)} 401 密码错误`);
      else console.log(`  ✘ ${p.padEnd(12)} ${r.status}`);
    } catch (e) { console.log(`  ✘ ${p.padEnd(12)} ${e.message}`); }
  }
  console.log(any ? '\n标 200 的路径可直接给 ffmpeg 用。' : '\n无可用码流，检查密码/IP。');
})();
