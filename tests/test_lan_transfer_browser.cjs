// 邻传真实浏览器端到端测试：多个独立浏览器上下文 + 真实 WebRTC，核对实际下载文件的 SHA-256。
// 先启动 `python tests/test_lan_transfer.py --serve --port 8765`（CI 里换成真实 uhttpd + 原生 ucode）。
// 需要 playwright 及其 Chromium；LAN_TRANSFER_URL 可指定页面地址，LAN_TRANSFER_SCREENSHOTS 指定截图目录。
'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const URL = process.env.LAN_TRANSFER_URL || 'http://127.0.0.1:8765/';
const SHOTS = process.env.LAN_TRANSFER_SCREENSHOTS;
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const errors = [], requests = [];

async function device(browser, name, opts = {}) {
  const ctx = await browser.newContext({
    acceptDownloads: true,
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: !!opts.mobile, hasTouch: !!opts.mobile
  });
  await ctx.addInitScript(([name, noRtc, blockDirect, hidden]) => {
    localStorage.setItem('lt-name', name);
    // 模拟页面在后台：轮询降到 8 秒一次
    if (hidden) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    localStorage.setItem('lt-autosave', '0');
    if (noRtc) delete window.RTCPeerConnection;
    // 模拟 AP 隔离：信令照常经路由器送达，但双方都拿不到对方的候选地址，ICE 必然失败
    if (blockDirect) {
      const strip = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate')).join('\r\n');
      const local = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription').get;
      Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', {
        get() { const d = local.call(this); return d && { type: d.type, sdp: strip(d.sdp) }; }
      });
      const remote = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (d) { return remote.call(this, { type: d.type, sdp: strip(d.sdp) }); };
    }
  }, [name, !!opts.noRtc, !!opts.blockDirect, !!opts.hidden]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('request', r => requests.push(r.url()));
  await page.goto(URL);
  return { ctx, page, name };
}

async function tile(from, to) {
  const t = from.page.locator('.peer', { has: from.page.locator('.peer-name', { hasText: to.name }) });
  await t.waitFor({ timeout: 20000 });
  return t;
}

async function offer(from, to, files) {
  const chooser = from.page.waitForEvent('filechooser');
  await (await tile(from, to)).locator('.btn.primary').click();
  await (await chooser).setFiles(files.map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: f.data })));
}

async function prompt(to, from) {
  const dialog = to.page.locator('.dialog', { hasText: `${from.name} 想发给你` });
  await dialog.waitFor({ timeout: 30000 });
  return dialog;
}

const newest = (page, dir) => page.locator(`.xfer[data-dir="${dir}"]:not([data-kind="text"])`).first();
async function state(page, dir, expected, timeout = 60000) {
  await page.waitForFunction(([dir, expected]) => {
    const card = document.querySelector(`.xfer[data-dir="${dir}"]:not([data-kind="text"])`);
    return card && card.dataset.state === expected;
  }, [dir, expected], { timeout });
  return newest(page, dir);
}

async function saveAll(to, files) {
  const card = newest(to.page, 'in');
  for (let i = 0; i < files.length; i++) {
    const waiting = to.page.waitForEvent('download');
    await card.locator('.xfer-files li').nth(i).locator('button', { hasText: '保存' }).click();
    const download = await waiting;
    assert.equal(sha(await fs.readFile(await download.path())), sha(files[i].data), `下载内容不一致：${files[i].name}`);
  }
}

async function transfer(from, to, files, via) {
  await offer(from, to, files);
  await (await prompt(to, from)).locator('.btn.primary').click();
  await state(to.page, 'in', 'done');
  const sent = await state(from.page, 'out', 'done');
  assert.match(await sent.locator('.xfer-meta').textContent(), via === 'p2p' ? /直连/ : /经路由器中转/);
  await saveAll(to, files);
}

function checkZip(file, files) {
  const expected = JSON.stringify(files.map(f => [f.saved, sha(f.data)]));
  execFileSync(PYTHON, ['-c', `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, 'CRC mismatch'
got = [[i.filename, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]
assert got == json.loads(sys.argv[2]), got
`, file, expected], { stdio: 'inherit' });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}) });
  try {
    const alice = await device(browser, '客厅电脑');
    if (SHOTS) {
      await fs.mkdir(SHOTS, { recursive: true });
      await alice.page.locator('#empty').waitFor();
      await alice.page.screenshot({ path: path.join(SHOTS, 'empty.png'), fullPage: true });
    }
    const bob = await device(browser, '小明手机', { mobile: true });
    const carol = await device(browser, '旧浏览器', { noRtc: true });
    for (const [a, b] of [[alice, bob], [alice, carol], [bob, alice], [carol, alice]]) await tile(a, b);
    assert.match(await (await tile(alice, carol)).locator('.peer-tags').textContent(), /中转/);
    console.log('PASS 三台设备互相发现，不支持 WebRTC 的设备标为中转');

    if (process.env.LAN_TRANSFER_STUN) {
      // 路由器上的 STUN 应答器必须让浏览器拿到带真实地址的 srflx 候选（mDNS 混淆时直连靠它）
      const srflx = await alice.page.evaluate(async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${location.hostname}:3478` }] });
        pc.createDataChannel('probe');
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 8000);
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
        });
        const sdp = pc.localDescription.sdp;
        pc.close();
        return sdp.split(/\r?\n/).filter(line => / typ srflx /.test(line));
      });
      assert.ok(srflx.length > 0, '浏览器没有从路由器 STUN 拿到 srflx 候选');
      console.log(`PASS 浏览器从内网 STUN 应答器拿到反射候选：${srflx[0]}`);
    }

    const files = [
      { name: 'photo.bin', data: crypto.randomBytes(5 * 1024 * 1024 + 321) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: '报告<终稿>&.pdf', saved: '报告_终稿_&.pdf', data: crypto.randomBytes(70000) }
    ];
    files[0].saved = files[0].name; files[1].saved = files[1].name;
    await transfer(alice, bob, files, 'p2p');
    const zip = bob.page.waitForEvent('download');
    await newest(bob.page, 'in').locator('button', { hasText: '打包 ZIP' }).click();
    const zipPath = path.join(os.tmpdir(), `lan-transfer-${Date.now()}.zip`);
    await (await zip).saveAs(zipPath);
    checkZip(zipPath, files);
    await fs.rm(zipPath, { force: true });
    console.log('PASS 直连多文件（含空文件、中文与特殊字符文件名），逐个保存与 ZIP 打包内容一致');

    await transfer(bob, alice, [{ name: 'reply.txt', data: Buffer.from('收到，谢谢\n') }], 'p2p');
    console.log('PASS 反向直连复用连接');

    await offer(alice, bob, [{ name: 'no.txt', data: Buffer.from('拒收') }]);
    await (await prompt(bob, alice)).locator('button', { hasText: '拒绝' }).click();
    assert.match(await (await state(alice.page, 'out', 'rejected')).locator('.xfer-status').textContent(), /拒绝/);
    console.log('PASS 接收方拒绝');

    await offer(alice, bob, [{ name: 'later.txt', data: Buffer.from('不发了') }]);
    await prompt(bob, alice);
    await newest(alice.page, 'out').locator('button', { hasText: '取消' }).click();
    await state(bob.page, 'in', 'cancelled');
    assert.equal(await bob.page.locator('.dialog').count(), 0, '发送方取消后接收确认框应关闭');
    console.log('PASS 发送方在对方确认前取消');

    // 放慢发送让“传输中取消”可控
    await alice.page.evaluate(() => {
      const send = RTCDataChannel.prototype.send;
      window.__slow = true;
      RTCDataChannel.prototype.send = function (value) {
        if (window.__slow && typeof value !== 'string') { const until = performance.now() + 25; while (performance.now() < until) { /* 忙等 */ } }
        return send.call(this, value);
      };
    });
    await offer(alice, bob, [{ name: 'big.bin', data: crypto.randomBytes(12 * 1024 * 1024) }]);
    await (await prompt(bob, alice)).locator('.btn.primary').click();
    await bob.page.waitForFunction(() => {
      const bar = document.querySelector('.xfer[data-dir="in"] .bar');
      const v = bar && Number(bar.getAttribute('aria-valuenow'));
      return v > 0 && v < 90;
    }, null, { timeout: 30000 });
    await newest(bob.page, 'in').locator('button', { hasText: '取消' }).click();
    await state(bob.page, 'in', 'cancelled');
    assert.match(await (await state(alice.page, 'out', 'cancelled')).locator('.xfer-status').textContent(), /对方取消/);
    assert.equal(await newest(bob.page, 'in').locator('button', { hasText: '保存' }).count(), 0);
    await alice.page.evaluate(() => { window.__slow = false; });
    console.log('PASS 接收方在传输中取消，未完成的文件不提供保存');

    await transfer(alice, bob, [{ name: 'after-cancel.txt', data: Buffer.from('取消后还能继续发') }], 'p2p');
    console.log('PASS 取消后继续传输');

    // 篡改一个真实数据包：接收方必须拒绝
    await alice.page.evaluate(() => {
      const send = RTCDataChannel.prototype.send;
      let done = false;
      RTCDataChannel.prototype.send = function (value) {
        if (!done && value instanceof Uint8Array && value.length > 8) { value[8] ^= 1; done = true; }
        return send.call(this, value);
      };
    });
    await offer(alice, bob, [{ name: 'crc.bin', data: crypto.randomBytes(100000) }]);
    await (await prompt(bob, alice)).locator('.btn.primary').click();
    assert.match(await (await state(bob.page, 'in', 'failed')).locator('.xfer-status').textContent(), /校验失败/);
    await state(alice.page, 'out', 'cancelled');
    console.log('PASS 数据被篡改时 CRC32 校验拒收');

    const text = '验证码 384 921\nhttps://example.com/a?b=1 <script>alert(1)</script>';
    await (await tile(alice, bob)).locator('button', { hasText: '发文字' }).click();
    await alice.page.locator('.dialog textarea').fill(text);
    await alice.page.locator('.dialog .btn.primary').click();
    const message = bob.page.locator('.dialog', { hasText: `${alice.name} 发来文字` });
    await message.waitFor({ timeout: 20000 });
    assert.equal(await message.locator('.message').textContent(), text);
    assert.equal(await bob.page.locator('script', { hasText: 'alert(1)' }).count(), 0);
    await message.locator('button', { hasText: '关闭' }).click();
    console.log('PASS 文字消息原样显示且不会被当作 HTML');

    await transfer(alice, carol, [{ name: 'relay.bin', data: crypto.randomBytes(3 * 1024 * 1024 + 5) }, { name: 'relay-empty.txt', data: Buffer.alloc(0) }], 'relay');
    await transfer(carol, alice, [{ name: '回传.bin', data: crypto.randomBytes(1024 * 1024) }], 'relay');
    console.log('PASS 不支持 WebRTC 时经路由器中转（双向，含整块边界与空文件）');

    const dave = await device(browser, '隔离设备', { blockDirect: true });
    const started = Date.now();
    await transfer(alice, dave, [{ name: 'fallback.bin', data: crypto.randomBytes(1500000) }], 'relay');
    console.log(`PASS 直连连不通时 ${Math.round((Date.now() - started) / 1000)} 秒内自动改走中转`);

    const grace = await device(browser, '后台页面', { hidden: true });
    await transfer(alice, grace, [{ name: 'slow-poll.bin', data: crypto.randomBytes(200000) }], 'p2p');
    console.log('PASS 对方页面在后台（慢轮询）时仍建立直连');

    const erin = await device(browser, '同时发起甲'), frank = await device(browser, '同时发起乙');
    await tile(erin, frank); await tile(frank, erin);
    const one = [{ name: 'e.txt', data: Buffer.from('甲发给乙') }], two = [{ name: 'f.txt', data: Buffer.from('乙发给甲') }];
    await Promise.all([offer(erin, frank, one), offer(frank, erin, two)]);
    await (await prompt(frank, erin)).locator('.btn.primary').click();
    await (await prompt(erin, frank)).locator('.btn.primary').click();
    await Promise.all([state(erin.page, 'in', 'done'), state(frank.page, 'in', 'done'), state(erin.page, 'out', 'done'), state(frank.page, 'out', 'done')]);
    await saveAll(frank, one);
    await saveAll(erin, two);
    for (const p of [erin, frank]) assert.match(await newest(p.page, 'out').locator('.xfer-meta').textContent(), /直连/);
    console.log('PASS 双方同时发起连接时仍建立直连');

    await alice.page.locator('#rename').click();
    await alice.page.locator('.dialog input').fill('书房电脑');
    await alice.page.locator('.dialog .btn.primary').click();
    alice.name = '书房电脑';
    await tile(bob, alice);
    await carol.page.close();
    await alice.page.waitForFunction(() => ![...document.querySelectorAll('.peer-name')].some(n => n.textContent === '旧浏览器'), null, { timeout: 15000 });
    console.log('PASS 改名同步、关闭页面后设备消失');

    await alice.page.locator('#invite').click();
    assert.equal(await alice.page.locator('.dialog .qr-large svg path').count(), 1);
    assert.equal(await alice.page.locator('.dialog .url').textContent(), new globalThis.URL(URL).origin + '/');
    if (SHOTS) {
      await alice.page.waitForTimeout(500);   // 等对话框动画结束
      await alice.page.screenshot({ path: path.join(SHOTS, 'invite.png') });
      await alice.page.keyboard.press('Escape');
      await alice.page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
      await bob.page.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
    }
    assert.equal(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '手机宽度不应出现横向滚动');
    assert.deepEqual(errors, []);
    const origin = new globalThis.URL(URL).origin;
    assert.ok(requests.every(u => u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:')), '不应请求外部资源');
    console.log('PASS 邀请二维码、手机布局、无页面错误、无外部请求');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
