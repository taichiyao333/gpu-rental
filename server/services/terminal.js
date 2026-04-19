/**
 * terminal.js - Real PTY terminal service via node-pty
 * Provides WebSocket-based terminal sessions for pod workspaces
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

let pty = null;
try {
    pty = require('node-pty');
    console.log('✅ node-pty loaded — real terminal available');
} catch (e) {
    console.warn('⚠️  node-pty not available, using mock terminal:', e.message);
}

// Active terminal sessions: socketId -> { ptyProcess, pod }
const sessions = new Map();

/**
 * Shell to use based on OS
 */
function getShell() {
    if (os.platform() === 'win32') {
        return { shell: 'powershell.exe', args: [] };
    }
    return { shell: process.env.SHELL || '/bin/bash', args: ['--login'] };
}

/**
 * Attach terminal to a WebSocket connection
 * @param {Socket} socket - Socket.IO socket
 * @param {Object} pod - Pod object with workspace_path
 * @param {Object} user - Authenticated user
 */
function attachTerminal(socket, pod, user) {
    if (sessions.has(socket.id)) return; // Already attached

    const workspacePath = pod?.workspace_path || os.homedir();

    // Ensure workspace exists
    if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
    }

    if (!pty) {
        // Mock terminal fallback
        attachMockTerminal(socket, workspacePath, user);
        return;
    }

    const { shell, args } = getShell();

    try {
        const ptyProcess = pty.spawn(shell, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: workspacePath,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                HOME: workspacePath,
                USER: user.username,
                WORKSPACE: workspacePath,
                GPU_POD_ID: String(pod?.id || ''),
            },
        });

        sessions.set(socket.id, { ptyProcess, pod, user });

        // PTY -> client
        ptyProcess.onData(data => {
            socket.emit('terminal:data', data);
        });

        // PTY exit
        ptyProcess.onExit(({ exitCode }) => {
            socket.emit('terminal:exit', { exitCode });
            sessions.delete(socket.id);
        });

        // client -> PTY
        socket.on('terminal:input', data => {
            try { ptyProcess.write(data); } catch { }
        });

        // Resize
        socket.on('terminal:resize', ({ cols, rows }) => {
            try { ptyProcess.resize(cols, rows); } catch { }
        });

        // Disconnect cleanup
        socket.on('disconnect', () => {
            detachTerminal(socket.id);
        });

        // Welcome message
        socket.emit('terminal:ready', { shell, workspacePath });
        console.log(`🖥 Terminal spawned for ${user.username} (shell: ${shell}, cwd: ${workspacePath})`);

    } catch (err) {
        console.error('PTY spawn error:', err.message);
        attachMockTerminal(socket, workspacePath, user);
    }
}

function attachMockTerminal(socket, workspacePath, user) {
    const { execSync } = require('child_process');
    let cwd = workspacePath;
    const history = [];

    const C = {
        reset : '\x1b[0m',  green : '\x1b[32m', yellow: '\x1b[33m',
        cyan  : '\x1b[36m', blue  : '\x1b[34m', red   : '\x1b[31m',
        bold  : '\x1b[1m',  dim   : '\x1b[2m',  white : '\x1b[37m',
    };

    const prompt = () => `\r\n${C.green}${user.username}${C.reset}@${C.cyan}gpu-pod${C.reset}:${C.blue}${cwd.replace(os.homedir(), '~')}${C.reset}$ `;

    socket.emit('terminal:data', `\r\n${C.green}${C.bold}GPU Rental Platform Terminal${C.reset}\r\n`);
    socket.emit('terminal:data', `${C.dim}Workspace: ${workspacePath}${C.reset}\r\n`);
    socket.emit('terminal:data', `${C.yellow}[Mock mode — node-pty not available on this build]${C.reset}\r\n`);
    socket.emit('terminal:data', prompt());

    // ── helper: サーバー側コマンドを安全に実行 ──
    function tryExec(cmd, fallback) {
        try { return execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim(); }
        catch (e) { return fallback || `(exec error: ${e.message.slice(0, 60)})`; }
    }

    // ── コマンドハンドラー ──
    function dispatch(raw) {
        const parts = raw.trim().split(/\s+/);
        const cmd   = parts[0];
        const args  = parts.slice(1);

        switch (cmd) {
            /* ─── ファイルシステム ─── */
            case 'ls': {
                const target = args[0] || cwd;
                try {
                    const entries = fs.readdirSync(target, { withFileTypes: true });
                    return entries.map(e => {
                        const name = e.isDirectory() ? `${C.blue}${e.name}/${C.reset}` : e.name;
                        return name;
                    }).join('  ') || '(empty)';
                } catch (e) { return `ls: ${target}: ${e.message}`; }
            }
            case 'pwd': return cwd;
            case 'cd': {
                const dest = args[0] ? path.resolve(cwd, args[0]) : os.homedir();
                if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) { cwd = dest; return ''; }
                return `cd: ${dest}: No such directory`;
            }
            case 'mkdir': {
                const p = path.resolve(cwd, args[0] || '');
                try { fs.mkdirSync(p, { recursive: true }); return `mkdir: created '${p}'`; }
                catch (e) { return `mkdir: ${e.message}`; }
            }
            case 'touch': {
                const p = path.resolve(cwd, args[0] || '');
                try { fs.closeSync(fs.openSync(p, 'a')); return ''; }
                catch (e) { return `touch: ${e.message}`; }
            }
            case 'cat': {
                const target = args[0];
                if (!target) return 'cat: missing file operand';
                const p = path.resolve(cwd, target);
                try {
                    if (!fs.existsSync(p)) return `cat: ${target}: No such file`;
                    return fs.readFileSync(p, 'utf8').slice(0, 4000);
                } catch (e) { return `cat: ${e.message}`; }
            }
            case 'du': {
                const target = args[args.length-1] || cwd;
                return tryExec(`du -sh "${target}" 2>&1`, `du: ${target}: unable to read`);
            }

            /* ─── システム情報 ─── */
            case 'uname': {
                const flag = args[0] || '-s';
                if (flag === '-a') return `${os.type()} ${os.hostname()} ${os.release()} ${os.arch()}`;
                if (flag === '-r') return os.release();
                if (flag === '-m') return os.arch();
                return os.type();
            }
            case 'hostname': return os.hostname();
            case 'whoami':   return user.username;
            case 'date':     return new Date().toLocaleString('ja-JP');
            case 'uptime': {
                const sec = Math.floor(os.uptime());
                const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
                return `up ${h}h ${m}m`;
            }
            case 'free': {
                const total = os.totalmem(), free = os.freemem(), used = total - free;
                const fmt = n => (n/1024/1024/1024).toFixed(1) + 'G';
                return `${C.bold}              total        used        free${C.reset}\nMem:          ${fmt(total)}      ${fmt(used)}      ${fmt(free)}`;
            }
            case 'df': {
                return tryExec('df -h 2>&1',
                    `Filesystem      Size   Used  Avail Use%\nF:/gpu-rental    2.0T  250G   1.8T  13%`);
            }
            case 'top':
            case 'htop': {
                const cpus = os.cpus();
                const header = `${C.bold}PID   CPU%  MEM   COMMAND${C.reset}`;
                const rows = [
                    `1     0.0%  0.1%  systemd`,
                    `${process.pid}  0.2%  ${(process.memoryUsage().rss/os.totalmem()*100).toFixed(1)}%  node (gpu-rental)`,
                ];
                return `CPU: ${cpus.length} cores — ${cpus[0]?.model}\n${header}\n${rows.join('\n')}\n(q to quit — mock, not interactive)`;
            }
            case 'ps': {
                return tryExec('tasklist /FO CSV /NH 2>&1 | head -20',
                    `PID   STAT COMMAND\n${process.pid}   R    node\n1     S    systemd`);
            }

            /* ─── GPU ─── */
            case 'nvidia-smi': {
                const nvsmi = tryExec('nvidia-smi 2>&1', null);
                if (nvsmi && !nvsmi.includes('exec error')) return nvsmi;
                return [
                    `${C.green}+-----------------------------------------------------------------------------+${C.reset}`,
                    `| NVIDIA-SMI 535.xx    Driver Version: 535.xx    CUDA Version: 12.2        |`,
                    `+------------------+----------------------+----------------------+`,
                    `| GPU 0: RTX A4500 |  45°C  P8   20W/200W |  2048MiB / 20470MiB |`,
                    `+------------------+----------------------+----------------------+`,
                ].join('\r\n');
            }

            /* ─── Python / pip ─── */
            case 'python':
            case 'python3': {
                if (args[0] === '--version' || args[0] === '-V') return tryExec('python --version 2>&1', 'Python 3.11.0');
                return 'Python 3.11.0 (mock — run python scripts via job submission)';
            }
            case 'pip':
            case 'pip3': {
                if (args[0] === 'list') return tryExec('pip list 2>&1', 'torch  2.2.0\ntorchvision  0.17.0\nnumpy  1.26.4\nPillow  10.2.0');
                if (args[0] === '--version') return tryExec('pip --version 2>&1', 'pip 24.0');
                return `pip: '${args[0]}' not supported in mock terminal`;
            }

            /* ─── ネットワーク ─── */
            case 'ifconfig':
            case 'ip': {
                return tryExec('ipconfig 2>&1',
                    `eth0: inet 192.168.1.100/24\nlo:   inet 127.0.0.1/8`);
            }
            case 'curl': {
                const url = args.find(a => a.startsWith('http'));
                if (!url) return 'curl: no URL specified';
                return `(mock) Would fetch: ${url}`;
            }

            /* ─── 環境変数 ─── */
            case 'env':
            case 'printenv': {
                const safeEnv = ['NODE_ENV','HOME','USER','SHELL','LANG','TERM','WORKSPACE','GPU_POD_ID','PATH'];
                return safeEnv.map(k => `${k}=${process.env[k] || ''}`).join('\n');
            }
            case 'echo': return args.join(' ');
            case 'export': return `export: ${args.join(' ')} (mock — persists for session only)`;

            /* ─── ユーティリティ ─── */
            case 'history': return history.slice(-20).map((h, i) => `  ${i+1}  ${h}`).join('\n');
            case 'clear':   return '\x1bc';
            case 'exit':    socket.emit('terminal:exit', { exitCode: 0 }); return '';
            case 'help':    return [
                `${C.bold}Available commands:${C.reset}`,
                `  ${C.cyan}File${C.reset}:   ls  pwd  cd  mkdir  touch  cat  du`,
                `  ${C.cyan}System${C.reset}: uname  hostname  whoami  date  uptime  free  df`,
                `  ${C.cyan}Process${C.reset}: top  htop  ps  nvidia-smi`,
                `  ${C.cyan}Python${C.reset}: python  python3  pip  pip3`,
                `  ${C.cyan}Network${C.reset}: ifconfig  ip  curl`,
                `  ${C.cyan}Env${C.reset}:    env  printenv  echo  export`,
                `  ${C.cyan}Shell${C.reset}:  history  clear  exit  help`,
            ].join('\r\n');

            default:
                // 安全なコマンドはサーバー側で実行を試みる
                if (/^(git|node|npm|which|find|grep|wc|sort|head|tail)\b/.test(raw)) {
                    return tryExec(raw + ' 2>&1', `${cmd}: command not found`);
                }
                return `${cmd}: command not found (type ${C.yellow}help${C.reset} for available commands)`;
        }
    }

    socket.on('terminal:input', (input) => {
        const cmd = input.replace(/\r?\n$/, '').trim();
        socket.emit('terminal:data', '\r\n');
        if (!cmd) { socket.emit('terminal:data', prompt()); return; }
        history.push(cmd);
        const out = dispatch(cmd);
        if (out) socket.emit('terminal:data', out.replace(/\n/g, '\r\n'));
        socket.emit('terminal:data', prompt());
    });

    sessions.set(socket.id, { ptyProcess: null, pod: null, user });
    socket.on('disconnect', () => sessions.delete(socket.id));
}

/**
 * Detach and kill terminal session
 */
function detachTerminal(socketId) {
    const session = sessions.get(socketId);
    if (!session) return;
    try { session.ptyProcess?.kill(); } catch { }
    sessions.delete(socketId);
}

/**
 * Get active session count
 */
function getSessionCount() {
    return sessions.size;
}

module.exports = { attachTerminal, detachTerminal, getSessionCount };
