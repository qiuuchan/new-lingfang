// =============================================================================
// 2048 小游戏插件入口（runtime_type: nodejs）
// -----------------------------------------------------------------------------
// 用 Node.js 标准库 http 起本地服务托管单页 2048 网页，启动后自动调用系统浏览器
// 打开 http://127.0.0.1:<port>。由桌面壳 start_plugin 命令 detached 运行
// （进程在独立进程组，软件内仅显示「运行中 + PID + 强制关闭」）。
//
// 关键约束（开发者务必遵守，否则运行会失败）：
// 1. 仅用 Node.js 内置模块（http/net/os/child_process 等）。sandbox 无 node_modules，
//    第三方包需改走 cloud 运行时。
// 2. 持久化通道 stdout=null（不进用户主界面），但仍用于打印「服务已启动」便于排障；
//    stderr 同理（崩溃诊断）。
// 3. 端口自动探测：从 41784 起递增找可用端口，避免与其它本地服务冲突。
// 4. 仅监听 127.0.0.1（本地回环），不对外暴露。
// 5. 进程在用户权限下运行，等价于本地 `node index.js`。请勿执行破坏性操作。
// =============================================================================

const http = require('http');
const net = require('net');
const os = require('os');
const { exec } = require('child_process');

// 端口探测范围。用高位非特权端口段，避开常见开发端口（3000/8080 等）。
const PORT_START = 41784;
const PORT_END = 41884;

/** 在 [start, end] 范围内找第一个可用 TCP 端口，找不到则 reject。 */
function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      if (port > end) {
        reject(new Error(`无可用端口（范围 ${start}-${end} 全占用）`));
        return;
      }
      const tester = net.createServer();
      tester.once('error', () => tester.close(() => probe(port + 1)));
      tester.once('listening', () => tester.close(() => resolve(port)));
      tester.listen(port, '127.0.0.1');
    };
    probe(start);
  });
}

/** 跨平台打开浏览器到指定 URL。失败仅打印 stderr，不阻断服务（用户可手动访问）。 */
function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.error(`[2048] 自动打开浏览器失败，请手动访问：${url}`);
      console.error(`[2048] 原因：${err.message}`);
    }
  });
}

/** 单页 2048 HTML（内联，零外部依赖）。CSS grid 定位 + 方向键/触摸滑动 + 计分。 */
function pageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>2048</title>
<style>
  :root { --bg:#faf8ef; --board:#bbada0; --cell:#cdc1b4; --text:#776e65; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html, body { height:100%; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--bg); color:var(--text);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    min-height:100vh; user-select:none; touch-action:none; padding:16px;
  }
  .header { width:360px; max-width:92vw; display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
  .title { font-size:48px; font-weight:800; color:var(--text); }
  .scores { display:flex; gap:8px; }
  .score-box { background:var(--board); border-radius:8px; padding:8px 16px; text-align:center; min-width:72px; }
  .score-label { color:#eee4da; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
  .score-value { color:#fff; font-size:22px; font-weight:800; }
  .toolbar { width:360px; max-width:92vw; display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
  .hint { font-size:13px; color:#9a8c7e; }
  .btn { background:#8f7a66; color:#f9f6f2; border:none; border-radius:6px; padding:8px 18px; font-size:14px; font-weight:700; cursor:pointer; }
  .btn:hover { background:#7c6856; }
  .grid { position:relative; width:360px; max-width:92vw; aspect-ratio:1; background:var(--board); border-radius:8px; padding:10px; }
  .tiles { position:absolute; inset:10px; display:grid; grid-template-columns:repeat(4,1fr); grid-template-rows:repeat(4,1fr); gap:10px; }
  .tile { display:flex; align-items:center; justify-content:center; font-weight:800; border-radius:6px; font-size:34px; }
  .tile.new { animation:pop .15s ease; }
  .tile.merged { animation:merge .18s ease; }
  @keyframes pop { from { transform:scale(0); } to { transform:scale(1); } }
  @keyframes merge { 0%{transform:scale(1);} 50%{transform:scale(1.18);} 100%{transform:scale(1);} }
  .bg { position:absolute; inset:10px; display:grid; grid-template-columns:repeat(4,1fr); grid-template-rows:repeat(4,1fr); gap:10px; }
  .bg i { background:var(--cell); border-radius:6px; display:block; }
  .overlay { position:absolute; inset:0; background:rgba(238,228,218,.82); border-radius:8px; display:none; flex-direction:column; align-items:center; justify-content:center; gap:14px; z-index:10; }
  .overlay.show { display:flex; }
  .overlay .msg { font-size:40px; font-weight:800; color:var(--text); }
  @media (max-width:400px) { .title { font-size:38px; } .tile { font-size:28px; } }
</style>
</head>
<body>
  <div class="header">
    <div class="title">2048</div>
    <div class="scores">
      <div class="score-box"><div class="score-label">分数</div><div class="score-value" id="score">0</div></div>
      <div class="score-box"><div class="score-label">最高</div><div class="score-value" id="best">0</div></div>
    </div>
  </div>
  <div class="toolbar">
    <div class="hint">方向键 / WASD / 滑动</div>
    <button class="btn" id="newGame">新游戏</button>
  </div>
  <div class="grid">
    <div class="bg" id="bg"></div>
    <div class="tiles" id="tiles"></div>
    <div class="overlay" id="overlay"><div class="msg" id="overlayMsg">游戏结束</div><button class="btn" onclick="newGame()">再来一局</button></div>
  </div>
<script>
const SIZE = 4;
let board, score, best, won = false;

// 各数值方块的颜色映射（经典 2048 配色）。深底配浅字，浅底配深字。
const COLORS = { 2:'#eee4da', 4:'#ede0c8', 8:'#f2b179', 16:'#f59563', 32:'#f67c5f', 64:'#f65e3b', 128:'#edcf72', 256:'#edcc61', 512:'#edc850', 1024:'#edc53f', 2048:'#edc22e' };
const DARK = new Set([8,16,32,64,128,256,512,1024,2048]);

function bestLoad(){ try { return parseInt(localStorage.getItem('lf2048best')||'0',10)||0; } catch { return 0; } }
function bestSave(v){ try { localStorage.setItem('lf2048best', String(v)); } catch {} }

function buildBg(){
  const bg = document.getElementById('bg'); bg.innerHTML = '';
  for (let i=0;i<SIZE*SIZE;i++){ const d=document.createElement('i'); bg.appendChild(d); }
}

function empty(){ return Array.from({length:SIZE}, ()=>Array(SIZE).fill(0)); }

// 在空格中随机放一个 2(90%) 或 4(10%)，返回放置坐标或 null。
function addRandom(){
  const cells = [];
  for (let r=0;r<SIZE;r++) for (let c=0;c<SIZE;c++) if (board[r][c]===0) cells.push([r,c]);
  if (cells.length===0) return null;
  const [r,c] = cells[Math.floor(Math.random()*cells.length)];
  board[r][c] = Math.random()<0.9 ? 2 : 4;
  return [r,c];
}

function newGame(){
  board = empty(); score = 0; won = false;
  const n1 = addRandom(), n2 = addRandom();
  render([n1, n2]);
  document.getElementById('score').textContent = '0';
  document.getElementById('overlay').classList.remove('show');
}

// 单行左移+合并：返回 {row, gained}。合并产生的新值计入 gained。
function slideLeft(row){
  const vals = row.filter(v => v !== 0);
  const out = []; let gained = 0;
  let i = 0;
  while (i < vals.length) {
    if (i+1 < vals.length && vals[i] === vals[i+1]) {
      const m = vals[i] * 2;
      out.push(m); gained += m;
      if (m === 2048) won = true;
      i += 2;
    } else { out.push(vals[i]); i++; }
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

const reverse = (row) => row.slice().reverse();
const transpose = (b) => b[0].map((_, c) => b.map(r => r[c]));

// 处理一次移动。无变化（合法但无位移）不计步、不补块。
function move(dir){
  if (document.getElementById('overlay').classList.contains('show')) return;
  const before = JSON.stringify(board);
  let totalGain = 0;
  const slide = (row) => { const res = slideLeft(row); totalGain += res.gained; return res.row; };
  let work;
  if (dir === 'left')      work = board.map(slide);
  else if (dir === 'right') work = board.map(r => reverse(slide(reverse(r))));
  else if (dir === 'up')    work = transpose(transpose(board).map(slide));
  else                      work = transpose(transpose(board).map(r => reverse(slide(reverse(r)))));
  if (JSON.stringify(work) === before) return;
  board = work; score += totalGain;
  if (score > best) { best = score; bestSave(best); }
  document.getElementById('best').textContent = best;
  const placed = addRandom();
  render(placed ? [placed] : []);
  if (!hasMoves()) { document.getElementById('overlayMsg').textContent = '游戏结束'; document.getElementById('overlay').classList.add('show'); }
  else if (won) { document.getElementById('overlayMsg').textContent = '达成 2048！'; document.getElementById('overlay').classList.add('show'); }
}

function hasMoves(){
  for (let r=0;r<SIZE;r++) for (let c=0;c<SIZE;c++){
    if (board[r][c] === 0) return true;
    if (c+1<SIZE && board[r][c] === board[r][c+1]) return true;
    if (r+1<SIZE && board[r][c] === board[r+1][c]) return true;
  }
  return false;
}

// 重绘全部方块。newCells 为本次新增的格子坐标列表，加 pop 动画。
function render(newCells){
  const container = document.getElementById('tiles');
  container.innerHTML = '';
  for (let r=0;r<SIZE;r++){
    for (let c=0;c<SIZE;c++){
      const v = board[r][c];
      if (v === 0) continue;
      const el = document.createElement('div');
      el.className = 'tile';
      el.style.gridRow = (r+1) + ' / ' + (r+2);
      el.style.gridColumn = (c+1) + ' / ' + (c+2);
      el.textContent = v;
      el.style.background = COLORS[v] || '#3c3a32';
      el.style.color = DARK.has(v) ? '#f9f6f2' : '#776e65';
      el.style.fontSize = v >= 1024 ? '26px' : v >= 128 ? '30px' : '34px';
      if (newCells && newCells.some(([nr,nc]) => nr===r && nc===c)) el.classList.add('new');
      container.appendChild(el);
    }
  }
  document.getElementById('score').textContent = score;
}

// 键盘控制（阻止页面滚动）。
const KEYMAP = { ArrowLeft:'left', a:'left', A:'left', ArrowRight:'right', d:'right', D:'right', ArrowUp:'up', w:'up', W:'up', ArrowDown:'down', s:'down', S:'down' };
window.addEventListener('keydown', e => {
  const dir = KEYMAP[e.key];
  if (!dir) return;
  e.preventDefault();
  move(dir);
});

// 触摸滑动控制。
let ts = null;
const gridEl = document.querySelector('.grid');
gridEl.addEventListener('touchstart', e => { const t = e.touches[0]; ts = { x:t.clientX, y:t.clientY }; }, { passive:true });
gridEl.addEventListener('touchend', e => {
  if (!ts) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - ts.x, dy = t.clientY - ts.y;
  ts = null;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
  if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
  else move(dy > 0 ? 'down' : 'up');
}, { passive:true });

document.getElementById('newGame').addEventListener('click', newGame);
best = bestLoad();
document.getElementById('best').textContent = best;
buildBg();
newGame();
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const body = pageHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.on('error', (err) => {
  console.error(`[2048] 服务启动失败：${err.message}`);
  process.exit(1);
});

async function main() {
  const port = await findFreePort(PORT_START, PORT_END);
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[2048] 服务已启动：${url}（主机 ${os.hostname()}，PID ${process.pid}）`);
    console.log(`[2048] 正在打开浏览器…若未自动打开请手动访问：${url}`);
    openBrowser(url);
  });

  // 优雅关闭：收到关闭信号时释放端口。
  const shutdown = (sig) => {
    console.error(`[2048] 收到 ${sig}，正在关闭服务…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
