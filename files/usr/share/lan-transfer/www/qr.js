'use strict';
/* 邻传二维码编码器：字节模式、纠错等级 M、版本 1–10（最多 213 字节），足够放下本页地址。
 * 算法照 ISO/IEC 18004 与 Nayuki 的参考实现，掩码按四项罚分自动选取；测试会与参考库逐模块比对。 */
(function (root) {
  // 纠错等级 M：[每块纠错码字数, [[块数, 每块数据码字数], ...]]
  const BLOCKS = [null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  // 生成多项式 ∏(x − αⁱ)，高次在前、去掉首项 1
  function divisor(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly.slice(1);
  }

  function remainder(data, gen) {
    const res = new Array(gen.length).fill(0);
    for (const byte of data) {
      const factor = byte ^ res.shift();
      res.push(0);
      for (let i = 0; i < gen.length; i++) res[i] ^= mul(gen[i], factor);
    }
    return res;
  }

  const dataCodewords = v => BLOCKS[v][1].reduce((sum, [count, size]) => sum + count * size, 0);

  function codewords(bytes, version) {
    const [ecLen, groups] = BLOCKS[version];
    const capacity = dataCodewords(version) * 8, bits = [];
    const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(4, 4);                                  // 字节模式 0100
    put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capacity - bits.length)); // 终止符
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    const gen = divisor(ecLen), blocks = [], ecc = [];
    let offset = 0;
    for (const [count, size] of groups) {
      for (let i = 0; i < count; i++) {
        const block = data.slice(offset, offset + size);
        offset += size;
        blocks.push(block);
        ecc.push(remainder(block, gen));
      }
    }
    const out = [], longest = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ecc) out.push(e[i]);
    return out;
  }

  function build(version, data) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALIGN[version], last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    drawFormat(modules, fixed, size, 0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }

    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (!fixed[y][x] && bit < data.length * 8) {
            modules[y][x] = ((data[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
            bit++;
          }
        }
      }
    }
    return { size, modules, fixed };
  }

  function drawFormat(modules, fixed, size, mask) {
    const data = mask;                          // 纠错等级 M 的格式位是 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  ];

  function applyMask(q, mask) {
    const out = q.modules.map(row => row.slice());
    for (let y = 0; y < q.size; y++) {
      for (let x = 0; x < q.size; x++) if (!q.fixed[y][x] && MASKS[mask](x, y)) out[y][x] = !out[y][x];
    }
    drawFormat(out, q.fixed.map(row => row.slice()), q.size, mask);
    return out;
  }

  function penalty(m) {
    const size = m.length;
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(m[y]);
    for (let x = 0; x < size; x++) lines.push(m.map(row => row[x]));
    for (const line of lines) {
      let color = false, run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = len => {
        if (history[0] === 0) len += size;       // 前面补一段浅色边框
        history.pop(); history.unshift(len);
      };
      const finderLike = () => {
        const n = history[1];
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
      };
      for (const cell of line) {
        if (cell === color) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          addHistory(run);
          if (!color) score += finderLike() * 40;
          color = cell;
          run = 1;
        }
      }
      if (color) { addHistory(run); run = 0; }
      addHistory(run + size);
      score += finderLike() * 40;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const cell of row) if (cell) dark++;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function encode(text, forcedMask) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 1;
    while (version <= 10 && bytes.length > dataCodewords(version) - (version < 10 ? 2 : 3)) version++;
    if (version > 10) throw new Error('内容太长，无法生成二维码');
    const q = build(version, codewords(bytes, version));
    let best = null, bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      if (forcedMask !== undefined && mask !== forcedMask) continue;
      const m = applyMask(q, mask), score = penalty(m);
      if (score < bestScore) { best = m; bestMask = mask; bestScore = score; }
    }
    return { version, mask: bestMask, size: q.size, modules: best };
  }

  // 渲染成 SVG（一条 path，四周留 4 格静区）
  function svg(text, label) {
    const { size, modules } = encode(text);
    const ns = 'http://www.w3.org/2000/svg', margin = 4, full = size + margin * 2;
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', `0 0 ${full} ${full}`);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label || text);
    el.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', full); bg.setAttribute('height', full); bg.setAttribute('fill', '#fff');
    let d = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!modules[y][x]) continue;
        let w = 1;
        while (x + w < size && modules[y][x + w]) w++;
        d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
        x += w - 1;
      }
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#111');
    el.append(bg, path);
    return el;
  }

  root.LtQr = { encode, svg };
})(typeof window !== 'undefined' ? window : globalThis);
