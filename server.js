const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const CLANS_FILE = path.join(DATA_DIR, 'clans.json');
const FRIEND_REQUESTS_FILE = path.join(DATA_DIR, 'friendRequests.json');

function readJSON(file, defaultValue) {
    if (!fs.existsSync(file)) return defaultValue;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateShortId(prefix = '') {
    return prefix + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 1. Регистрация
app.post('/api/register', async (req, res) => {
    let { playerId, name } = req.body;
    let players = readJSON(PLAYERS_FILE, []);
    let player = players.find(p => p.playerId === playerId);
    if (!player) {
        player = {
            playerId: playerId || generateShortId('p_'),
            name: name || 'Игрок',
            coins: 200,
            clickUpgradeLevel: 0,
            totalClicks: 0,
            inventory: [],
            marketListings: [],
            level: 1,
            xp: 0,
            totalCoinsEarned: 200,
            totalChestsOpened: 0,
            activeQuest: {
                type: 'clicks',
                target: 20,
                rewardCoins: 80,
                rewardXp: 40,
                current: 0
            },
            referralCode: generateShortId('ref_'),
            usedReferralCode: null,
            friends: [],
            clanId: null
        };
        players.push(player);
        writeJSON(PLAYERS_FILE, players);
    }
    res.json(player);
});

// 2. Сохранение прогресса
app.post('/api/save', async (req, res) => {
    const { playerId, data } = req.body;
    let players = readJSON(PLAYERS_FILE, []);
    const index = players.findIndex(p => p.playerId === playerId);
    if (index !== -1) {
        players[index] = { ...players[index], ...data, lastSave: new Date() };
        writeJSON(PLAYERS_FILE, players);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

// 3. Загрузка игрока
app.get('/api/load/:playerId', async (req, res) => {
    const players = readJSON(PLAYERS_FILE, []);
    const player = players.find(p => p.playerId === req.params.playerId);
    if (player) res.json(player);
    else res.status(404).json({ error: 'Player not found' });
});

// 4. Пригласить друга
app.post('/api/friends/invite', async (req, res) => {
    const { fromPlayerId, toPlayerIdOrCode } = req.body;
    let players = readJSON(PLAYERS_FILE, []);
    let target = players.find(p => p.referralCode === toPlayerIdOrCode);
    if (!target) target = players.find(p => p.playerId === toPlayerIdOrCode);
    if (!target) return res.status(404).json({ error: 'Игрок не найден' });
    if (fromPlayerId === target.playerId) return res.status(400).json({ error: 'Нельзя пригласить себя' });

    let requests = readJSON(FRIEND_REQUESTS_FILE, []);
    const existing = requests.find(r => r.fromPlayerId === fromPlayerId && r.toPlayerId === target.playerId && r.status === 'pending');
    if (existing) return res.json({ message: 'Запрос уже отправлен' });

    requests.push({
        id: uuidv4(),
        fromPlayerId,
        toPlayerId: target.playerId,
        status: 'pending',
        createdAt: new Date()
    });
    writeJSON(FRIEND_REQUESTS_FILE, requests);
    res.json({ message: 'Приглашение отправлено, ожидание подтверждения' });
});

// 5. Получить входящие запросы
app.get('/api/friends/pending/:playerId', async (req, res) => {
    const requests = readJSON(FRIEND_REQUESTS_FILE, []);
    const pending = requests.filter(r => r.toPlayerId === req.params.playerId && r.status === 'pending');
    const players = readJSON(PLAYERS_FILE, []);
    const enriched = pending.map(r => {
        const from = players.find(p => p.playerId === r.fromPlayerId);
        return { ...r, fromName: from ? from.name : '?' };
    });
    res.json(enriched);
});

// 6. Ответить на запрос
app.post('/api/friends/respond', async (req, res) => {
    const { requestId, action } = req.body;
    let requests = readJSON(FRIEND_REQUESTS_FILE, []);
    const requestIndex = requests.findIndex(r => r.id === requestId);
    if (requestIndex === -1) return res.status(404).json({ error: 'Запрос не найден' });
    const request = requests[requestIndex];
    if (action === 'reject') {
        request.status = 'rejected';
        writeJSON(FRIEND_REQUESTS_FILE, requests);
        return res.json({ message: 'Запрос отклонён' });
    }
    if (action === 'accept') {
        request.status = 'accepted';
        writeJSON(FRIEND_REQUESTS_FILE, requests);
        let players = readJSON(PLAYERS_FILE, []);
        const fromPlayer = players.find(p => p.playerId === request.fromPlayerId);
        const toPlayer = players.find(p => p.playerId === request.toPlayerId);
        if (fromPlayer && toPlayer) {
            if (!fromPlayer.friends.some(f => f.playerId === toPlayer.playerId))
                fromPlayer.friends.push({ playerId: toPlayer.playerId, name: toPlayer.name });
            if (!toPlayer.friends.some(f => f.playerId === fromPlayer.playerId))
                toPlayer.friends.push({ playerId: fromPlayer.playerId, name: fromPlayer.name });
            const bonus = Math.floor(Math.random() * 401) + 100;
            fromPlayer.coins += bonus;
            toPlayer.coins += bonus;
            writeJSON(PLAYERS_FILE, players);
        }
        return res.json({ message: 'Дружба подтверждена! Бонус начислен.' });
    }
    res.status(400).json({ error: 'Неверное действие' });
});

// 7. Создать клан
app.post('/api/clans/create', async (req, res) => {
    const { leaderId, name, icon, description, isPrivate, password } = req.body;
    const clans = readJSON(CLANS_FILE, []);
    if (clans.some(c => c.name === name)) return res.status(400).json({ error: 'Клан с таким именем уже существует' });
    const clanId = generateShortId('cl_');
    let passwordHash = null;
    if (isPrivate && password) passwordHash = await bcrypt.hash(password, 10);
    const newClan = {
        clanId,
        name,
        icon: icon || '🏰',
        description: description || '',
        private: isPrivate || false,
        passwordHash,
        leaderId,
        members: [{ playerId: leaderId, name: '', level: 1 }]
    };
    const players = readJSON(PLAYERS_FILE, []);
    const leader = players.find(p => p.playerId === leaderId);
    if (leader) newClan.members[0].name = leader.name;
    clans.push(newClan);
    writeJSON(CLANS_FILE, clans);
    if (leader) { leader.clanId = clanId; writeJSON(PLAYERS_FILE, players); }
    res.json(newClan);
});

// 8. Вступить в клан
app.post('/api/clans/join', async (req, res) => {
    const { playerId, clanId, password } = req.body;
    let clans = readJSON(CLANS_FILE, []);
    const clan = clans.find(c => c.clanId === clanId);
    if (!clan) return res.status(404).json({ error: 'Клан не найден' });
    if (clan.private) {
        if (!password) return res.status(403).json({ error: 'Требуется пароль' });
        const ok = await bcrypt.compare(password, clan.passwordHash);
        if (!ok) return res.status(403).json({ error: 'Неверный пароль' });
    }
    let players = readJSON(PLAYERS_FILE, []);
    const player = players.find(p => p.playerId === playerId);
    if (!player) return res.status(404).json({ error: 'Игрок не найден' });
    if (player.clanId) return res.status(400).json({ error: 'Вы уже в клане' });
    if (clan.members.some(m => m.playerId === playerId)) return res.status(400).json({ error: 'Уже участник' });
    clan.members.push({ playerId, name: player.name, level: player.level });
    writeJSON(CLANS_FILE, clans);
    player.clanId = clanId;
    writeJSON(PLAYERS_FILE, players);
    res.json(clan);
});

// 9. Поиск игроков
app.get('/api/search/players', async (req, res) => {
    const { q } = req.query;
    const players = readJSON(PLAYERS_FILE, []);
    const filtered = players.filter(p => p.name.toLowerCase().includes(q.toLowerCase()))
        .map(p => ({ playerId: p.playerId, name: p.name, level: p.level, coins: p.coins }));
    res.json(filtered.slice(0, 20));
});

// 10. Поиск кланов
app.get('/api/search/clans', async (req, res) => {
    const { q } = req.query;
    let clans = readJSON(CLANS_FILE, []);
    const filtered = clans.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))
        .map(c => ({ clanId: c.clanId, name: c.name, icon: c.icon, membersCount: c.members.length, private: c.private }));
    res.json(filtered.slice(0, 20));
});

// 11. Получить клан по ID
app.get('/api/clans/:clanId', async (req, res) => {
    const clans = readJSON(CLANS_FILE, []);
    const clan = clans.find(c => c.clanId === req.params.clanId);
    if (!clan) return res.status(404).json({ error: 'Not found' });
    res.json(clan);
});

// 12. Получить всех игроков для рейтинга
app.get('/api/players/all', async (req, res) => {
    const players = readJSON(PLAYERS_FILE, []);
    res.json(players.map(p => ({ playerId: p.playerId, name: p.name, level: p.level, coins: p.coins })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));