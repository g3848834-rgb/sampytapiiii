const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = 'teste123';
const PUBLIC_HOST = 'SEU_LINK_DO_RENDER_AQUI.onrender.com'; // Coloque o link definitivo aqui depois que criar no Render
const CACHE_DIR = path.join(__dirname, 'cache');

const MAX_SEARCH_RESULTS = 16;
const YT_FETCH_COUNT = 24;
const MAX_DURATION_SEC = 15 * 60;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_FILES = 100;
const MAX_CACHE_MB = 300;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const searchCache = new Map();
const activeJobs = new Map();

function cleanText(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/[|{}%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function isValidVideoId(id) {
    return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return '';
    }
    const total = Math.floor(seconds);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function parseDurationToSec(durStr) {
    if (!durStr) return 0;
    const parts = String(durStr).trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

function removeFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
}

function enforceCacheLimit() {
    try {
        const files = fs.readdirSync(CACHE_DIR)
            .filter(f => f.endsWith('.mp3'))
            .map(f => {
                const fullPath = path.join(CACHE_DIR, f);
                const stat = fs.statSync(fullPath);
                return { fullPath, size: stat.size, mtime: stat.mtimeMs };
            })
            .sort((a, b) => a.mtime - b.mtime);

        let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
        const maxBytes = MAX_CACHE_MB * 1024 * 1024;

        while (files.length > MAX_CACHE_FILES || totalBytes > maxBytes) {
            const oldest = files.shift();
            if (!oldest) break;
            fs.unlinkSync(oldest.fullPath);
            totalBytes -= oldest.size;
        }
    } catch (err) {}
}

function startStreamJob(id) {
    if (activeJobs.has(id)) {
        return activeJobs.get(id).readyPromise;
    }

    const mp3Path = path.join(CACHE_DIR, `${id}.mp3`);
    const partPath = path.join(CACHE_DIR, `${id}.mp3.part`);
    const ytUrl = `https://www.youtube.com/watch?v=${id}`;

    removeFileSafe(partPath);

    let resolveReady, rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    const job = {
        id,
        chunks: [],
        totalBytes: 0,
        listeners: new Set(),
        readyResolved: false,
        readyPromise,
        partPath
    };

    activeJobs.set(id, job);

    const yt = spawn('yt-dlp', [
        '--js-runtimes', 'node',
        '-f', 'bestaudio[abr<=128][filesize<25M]/bestaudio[filesize<25M]/bestaudio',
        '--no-playlist',
        '--max-filesize', '25M',
        '-o', '-',
        ytUrl
    ]);

    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0', '-vn',
        '-c:a', 'libmp3lame', '-b:a', '96k',
        '-compression_level', '9', '-ar', '44100', '-ac', '2',
        '-f', 'mp3', 'pipe:1'
    ]);

    const fileStream = fs.createWriteStream(partPath);
    let ytCode = null;
    let finished = false;

    const failJob = (reason) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (!yt.killed) yt.kill('SIGKILL');
        if (!ff.killed) ff.kill('SIGKILL');
        try { fileStream.destroy(); } catch (_) {}
        removeFileSafe(partPath);

        for (const res of job.listeners) { if (!res.writableEnded) res.end(); }
        job.listeners.clear();
        job.chunks = [];
        activeJobs.delete(id);

        if (!job.readyResolved) {
            job.readyResolved = true;
            rejectReady(new Error(reason));
        }
    };

    const timeout = setTimeout(() => failJob('Timeout no download'), 90000);

    yt.stdout.pipe(ff.stdin);
    yt.on('error', err => failJob(err.message));
    ff.on('error', err => failJob(err.message));
    yt.on('close', (code) => { ytCode = code; });

    ff.stdout.on('data', (chunk) => {
        if (finished) return;
        job.chunks.push(chunk);
        job.totalBytes += chunk.length;
        fileStream.write(chunk);

        for (const res of job.listeners) {
            if (!res.writableEnded) res.write(chunk);
        }

        if (!job.readyResolved && job.totalBytes >= 16384) {
            job.readyResolved = true;
            resolveReady();
        }
    });

    ff.on('close', (ffCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        const ok = ffCode === 0 && (ytCode === 0 || ytCode === null) && job.totalBytes > 0;
        if (!ok) {
            failJob(`Falha conversao`);
            return;
        }

        fileStream.end(() => {
            try {
                if (fs.existsSync(partPath) && fs.statSync(partPath).size > 0) {
                    fs.renameSync(partPath, mp3Path);
                    enforceCacheLimit();
                }
            } catch (err) {}

            for (const res of job.listeners) { if (!res.writableEnded) res.end(); }
            job.listeners.clear();
            job.chunks = [];
            activeJobs.delete(id);

            if (!job.readyResolved) {
                job.readyResolved = true;
                resolveReady();
            }
        });
    });

    return readyPromise;
}

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/search', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).send('Busca vazia');

    const cacheKey = q.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < SEARCH_CACHE_TTL) {
        return res.type('text/plain').send(cached.body);
    }

    const proc = spawn('yt-dlp', [
        `ytsearch${YT_FETCH_COUNT}:${q}`,
        '--flat-playlist', '--dump-json', '--no-warnings', '--ignore-errors', '--skip-download'
    ]);

    let out = '';
    const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        res.status(504).send('Tempo esgotado');
    }, 15000);

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
        clearTimeout(timer);
        const lines = [];
        const seenIds = new Set();

        for (const rawLine of out.split('\n')) {
            if (lines.length >= MAX_SEARCH_RESULTS) break;
            const trimmed = rawLine.trim();
            if (!trimmed) continue;

            try {
                const item = JSON.parse(trimmed);
                if (!item.id || !isValidVideoId(item.id) || seenIds.has(item.id)) continue;
                if (item.is_live || item.live_status === 'is_live') continue;

                let durSec = typeof item.duration === 'number' ? item.duration : 0;
                if (!durSec && item.duration_string) durSec = parseDurationToSec(item.duration_string);
                if (durSec <= 0 || durSec > MAX_DURATION_SEC) continue;

                const dur = formatDuration(durSec);
                const title = cleanText(item.title);
                if (!dur || !title) continue;

                seenIds.add(item.id);
                lines.push(`${item.id}|${cleanText(dur)}|${title}`);
            } catch (_) {}
        }

        const body = lines.join('\n');
        if (lines.length > 0) {
            searchCache.set(cacheKey, { body, count: lines.length, time: Date.now() });
        }
        res.type('text/plain').send(body);
    });
});

app.get('/api/download/:id', async (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const id = req.params.id;
    if (!isValidVideoId(id)) return res.status(400).send('ID invalido');

    const mp3Path = path.join(CACHE_DIR, `${id}.mp3`);
    const reqHost = req.query.host ? String(req.query.host).replace(/[^a-zA-Z0-9.:-]/g, '') : '';
    const hostToUse = reqHost || ((req.headers.host && req.headers.host.includes(':')) ? req.headers.host : PUBLIC_HOST);
    const playUrl = `https://${hostToUse}/api/stream/${id}.mp3`;

    if (fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 0) {
        return res.type('text/plain').send(playUrl);
    }

    try {
        await startStreamJob(id);
        return res.type('text/plain').send(playUrl);
    } catch (err) {
        return res.status(403).send('Erro ao converter');
    }
});

app.get('/api/stream/:filename', (req, res) => {
    const match = req.params.filename.match(/^([a-zA-Z0-9_-]{11})\.mp3$/);
    if (!match) return res.status(400).send('Invalido');

    const id = match[1];
    const filePath = path.join(CACHE_DIR, `${id}.mp3`);
    const startSec = Math.max(0, Math.min(3600, parseInt(req.query.t, 10) || 0));

    if (!fs.existsSync(filePath)) return res.status(404).send('Nao encontrado');

    if (startSec < 2) {
        return res.type('audio/mpeg').sendFile(filePath);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(startSec), '-i', filePath,
        '-vn', '-c:a', 'copy', '-f', 'mp3', 'pipe:1'
    ]);

    ff.stdout.pipe(res);
    res.on('close', () => { if (!res.writableEnded && !ff.killed) ff.kill('SIGKILL'); });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`API rodando na porta ${PORT}`);
});
