const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const Shared = require("./shared_cards.js");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/**
 * =========================
 *  Fake Accounts (server-memory)
 * =========================
 * - No DB. Reseta quando reiniciar o servidor.
 * - Token tipo "session" salvo no localStorage do cliente.
 */
const usersByName = new Map();   // username -> { username, passHash, token, deck: [dbId...] }
const usersByToken = new Map();  // token -> username

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}
function sanitizeUsername(u) {
  return String(u || "").trim().slice(0, 24);
}
function authFromReq(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const username = usersByToken.get(token);
  if (!username) return null;
  const user = usersByName.get(username);
  if (!user || user.token !== token) return null;
  return user;
}

/** Register */
app.post("/api/register", (req, res) => {
  const username = sanitizeUsername(req.body?.username);
  const password = String(req.body?.password || "");
  if (!username || username.length < 3) return res.status(400).json({ ok: false, error: "Username mínimo 3 caracteres." });
  if (!password || password.length < 3) return res.status(400).json({ ok: false, error: "Senha mínima 3 caracteres." });
  if (usersByName.has(username)) return res.status(409).json({ ok: false, error: "Username já existe." });

  const token = newToken();
  const user = { username, passHash: sha256(password), token, deck: [] };
  usersByName.set(username, user);
  usersByToken.set(token, username);

  return res.json({ ok: true, token, username });
});

/** Login */
app.post("/api/login", (req, res) => {
  const username = sanitizeUsername(req.body?.username);
  const password = String(req.body?.password || "");
  const user = usersByName.get(username);
  if (!user) return res.status(401).json({ ok: false, error: "Credenciais inválidas." });
  if (user.passHash !== sha256(password)) return res.status(401).json({ ok: false, error: "Credenciais inválidas." });

  // regen token
  const token = newToken();
  if (user.token) usersByToken.delete(user.token);
  user.token = token;
  usersByToken.set(token, username);

  return res.json({ ok: true, token, username });
});

/** Me */
app.get("/api/me", (req, res) => {
  const user = authFromReq(req);
  if (!user) {
    // IMPORTANT: do not return 401 here to avoid breaking socket flow
    return res.json({ ok: false, logged: false });
  }
  const v = Shared.validateDeck(user.deck);
  return res.json({
    ok: true,
    logged: true,
    username: user.username,
    hasDeck: v.ok,
    deckSize: user.deck.length,
    deckErrors: v.errors
  });
});

/** Get cards */
app.get("/api/cards", (req, res) => {
  // public
  return res.json({ ok: true, cards: Shared.ALL_CARDS });
});

/** Get deck */
app.get("/api/deck", (req, res) => {
  const user = authFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: "Sem auth" });
  return res.json({ ok: true, deck: user.deck });
});

/** Save deck */
app.post("/api/deck", (req, res) => {
  const user = authFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: "Sem auth" });

  const deck = Array.isArray(req.body?.deck) ? req.body.deck : [];
  const v = Shared.validateDeck(deck);
  if (!v.ok) return res.status(400).json({ ok: false, error: "Deck inválido", errors: v.errors });

  user.deck = deck.slice();
  return res.json({ ok: true, deckSize: user.deck.length });
});

/**
 * =========================
 *  Multiplayer / Rooms
 * =========================
 */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map(); // roomId -> {id, players:[{socketId, role, username}], match, state}

/**
 * Regras do jogo
 */
const MAX_PI = 7;
const ATTACK_PA_COST = 2;
const MAX_CARD_PA = 11;
const END_TURN_PA_GAIN = 2;
const PLAYER_START_HP = 1000;
const PLAYER_DEF = 20;

function createEmptyPlayerState() {
  return {
    playerHp: PLAYER_START_HP,
    playerMaxHp: PLAYER_START_HP,
    playerDef: PLAYER_DEF,
    hand: [],
    deck: [],
    back: Array(5).fill(null),
    front: Array(5).fill(null),
    graveyard: [],
    handCount: 0,
    deckCount: 0,
    pi: MAX_PI,
    maxPi: MAX_PI,
    username: "",
  };
}

function createNewGameState() {
  return { p1: createEmptyPlayerState(), p2: createEmptyPlayerState() };
}

function roomsPublicList() {
  return Array.from(rooms.values()).map((r) => ({
    id: r.id,
    playersCount: r.players.length,
    players: r.players.map(p => p.username),
  }));
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function enemyRoleOf(role) { return role === "p1" ? "p2" : "p1"; }
function isValidLine(line) { return line === "front" || line === "back"; }
function isValidIndex(i) { return Number.isInteger(i) && i >= 0 && i < 5; }
function frontHasAny(room, role) { return room.state[role].front.some((c) => c !== null); }

function canAttackBack(attackerCard, room, enemyRole) {
  const t = attackerCard?.type;
  if (t === "Ranged" || t === "Support") return true;
  if (t === "Melee" || t === "Tank") return !frontHasAny(room, enemyRole);
  return false;
}

function applyPlayerDamageFromCardHit(room, ownerRole, cardDamage) {
  const ps = room.state[ownerRole];
  if (!ps) return 0;
  const def = Number.isInteger(ps.playerDef) ? ps.playerDef : PLAYER_DEF;
  const raw = (Number.isInteger(cardDamage) ? cardDamage : 0) - def;
  const finalDmg = raw > 0 ? raw : 0;
  if (finalDmg > 0) {
    const cur = Number.isInteger(ps.playerHp) ? ps.playerHp : PLAYER_START_HP;
    ps.playerHp = Math.max(0, cur - finalDmg);
  }
  return finalDmg;
}


// ===== Abilities (incremental v1) =====
const HAB_COST_PA = 3;
const HAB_COOLDOWN_TURNS = 1; // one use per own turn

function cardKey(round, role){ return `${round}:${role}`; }

function removeExpiredBuffsForRoleEnd(room, role){
  const round = room.match.round;
  const ps = room.state[role];
  if (!ps) return;
  const lines = ["front","back"];
  for (const ln of lines){
    for (let i=0;i<5;i++){
      const c = ps[ln][i];
      if (!c || !Array.isArray(c.buffs) || c.buffs.length===0) continue;
      const keep = [];
      for (const b of c.buffs){
        if (b && b.expiresRound===round && b.expiresRole===role){
          if (b.kind==="atk"){
            c.atk = Math.max(0, (Number.isInteger(c.atk)?c.atk:0) - (Number.isInteger(b.amount)?b.amount:0));
          }
          // future buffs here
        } else keep.push(b);
      }
      c.buffs = keep;
    }
  }
}

function abilityKindForCard(card){
  // Simple rules for incremental v1:
  // Support: heal an allied card
  // Utility: gain PA on self
  // Others: buff self ATK until end of current turn
  const t = String(card?.type||"").toUpperCase();
  if (t === "SUPPORT") return "HEAL_ALLY";
  if (t === "UTILITY") return "GAIN_PA_SELF";
  return "BUFF_ATK_SELF";
}

function ultimateKindForCard(card){
  const k = String(card?.ultKind || "").toUpperCase();
  if (k) return k;
  const t = String(card?.type||"").toUpperCase();
  if (t === "SUPPORT") return "HEAL_ALLY_ULT";
  if (t === "UTILITY") return "GAIN_PI_ULT";
  return "BIG_HIT";
}


function applyHab(room, role, from, target){
  const round = room.match.round;
  const ps = room.state[role];
  if (!ps) return { ok:false, reason:"no_player" };

  const attacker = ps[from.line]?.[from.index];
  if (!attacker) return { ok:false, reason:"no_card" };

  // cost + cooldown
  const k = cardKey(round, role);
  if (attacker.lastHabAt === k) return { ok:false, reason:"cooldown" };
  if ((Number.isInteger(attacker.pa)?attacker.pa:0) < HAB_COST_PA) return { ok:false, reason:"no_pa" };

  const kind = abilityKindForCard(attacker);

  let result = { kind, from, role, ok:true };

  // pay cost
  attacker.pa -= HAB_COST_PA;
  attacker.lastHabAt = k;

  if (kind === "HEAL_ALLY") {
    if (!target || target.role !== role) return { ok:false, reason:"need_ally_target" };
    const tps = room.state[target.role];
    const tc = tps?.[target.pos?.line]?.[target.pos?.index];
    if (!tc) return { ok:false, reason:"bad_target" };
    const heal = 80;
    const maxHp = Number.isInteger(tc.maxHp) ? tc.maxHp : (Number.isInteger(tc.hp)?tc.hp:0);
    const before = Number.isInteger(tc.hp)?tc.hp:0;
    tc.hp = Math.min(maxHp, before + heal);
    result.delta = tc.hp - before;
    result.target = { role: target.role, pos: target.pos };
  } else if (kind === "GAIN_PA_SELF") {
    const gain = 2;
    const before = Number.isInteger(attacker.pa)?attacker.pa:0;
    attacker.pa = Math.min(11, before + gain);
    result.delta = attacker.pa - before;
  } else if (kind === "BUFF_ATK_SELF") {
    const amt = 30;
    attacker.atk = (Number.isInteger(attacker.atk)?attacker.atk:0) + amt;
    if (!Array.isArray(attacker.buffs)) attacker.buffs = [];
    attacker.buffs.push({ kind:"atk", amount: amt, expiresRound: round, expiresRole: role });
    result.delta = amt;
  }

  return result;
}

function applyUlt(room, role, from, target){
  const round = room.match.round;
  const ps = room.state[role];
  if (!ps) return { ok:false, reason:"no_player" };

  const caster = ps[from.line]?.[from.index];
  if (!caster) return { ok:false, reason:"no_card" };

  const kturn = cardKey(round, role);
  if (caster.lastUltAt === kturn) return { ok:false, reason:"cooldown" };
  if ((Number.isInteger(caster.pa)?caster.pa:0) < ULT_COST_PA) return { ok:false, reason:"no_pa" };

  const kind = ultimateKindForCard(caster);
  let result = { ok:true, kind, role, from };

  // pay cost + mark cooldown
  caster.pa = (Number.isInteger(caster.pa)?caster.pa:0) - ULT_COST_PA;
  caster.lastUltAt = kturn;

  if (kind === "GAIN_PI_ULT"){
    const before = ps.pi ?? 0;
    ps.pi = Math.min(7, before + 2);
    result.delta = (ps.pi - before);
    return result;
  }

  if (kind === "HEAL_ALLY_ULT"){
    if (!target || target.role !== role) return { ok:false, reason:"need_ally_target" };
    const ally = ps[target.pos.line]?.[target.pos.index];
    if (!ally) return { ok:false, reason:"no_target" };
    const before = Number.isInteger(ally.hp) ? ally.hp : 0;
    const maxHp = Number.isInteger(ally.maxHp) ? ally.maxHp : before;
    const heal = 8;
    ally.hp = Math.min(maxHp, before + heal);
    result.target = { role, pos: target.pos };
    result.delta = ally.hp - before;
    return result;
  }

  // BIG_HIT default: requires enemy target
  const enemyRole = enemyRoleOf(role);
  if (!target || target.role !== enemyRole) return { ok:false, reason:"need_enemy_target" };
  const opp = room.state[enemyRole];
  const victim = opp[target.pos.line]?.[target.pos.index];
  if (!victim) return { ok:false, reason:"no_target" };

  const raw = Math.max(1, Math.floor((Number.isInteger(caster.atk)?caster.atk:0) * 2.0));
  const mitigated = Math.max(0, raw - (Number.isInteger(victim.def)?victim.def:0));
  victim.hp = (Number.isInteger(victim.hp)?victim.hp:0) - mitigated;

  result.target = { role: enemyRole, pos: target.pos };
  result.dmg = mitigated;

  const deaths = [];
  if ((Number.isInteger(victim.hp)?victim.hp:0) <= 0){
    deaths.push({ role: enemyRole, from: { line: target.pos.line, index: target.pos.index }, card: { ...victim, hp: 0 } });
    opp.graveyard.push({ ...victim, hp: 0 });
    opp[target.pos.line][target.pos.index] = null;
  }
  result.deaths = deaths;
  return result;
}


function redactStateForRole(fullState, viewerRole) {
  const enemyRole = viewerRole === "p1" ? "p2" : "p1";
  const clone = JSON.parse(JSON.stringify(fullState));
  // hide enemy hand+deck
  clone[enemyRole].hand = [];
  clone[enemyRole].deck = [];
  return clone;
}

function emitEvent(room, event) {
  io.to(room.id).emit("game:event", event);
}

function sendSync(room) {
  for (const p of room.players) {
    io.to(p.socketId).emit("game:sync", {
      roomId: room.id,
      role: p.role,
      username: p.username,
      activeRole: room.match.activeRole,
      round: room.match.round,
      state: redactStateForRole(room.state, p.role),
    });
  }
}

function drawOne(room, role) {
  const ps = room.state[role];
  if (!ps || !ps.deck || ps.deck.length === 0) return null;

  const card = ps.deck.shift();
  ps.hand.push(card);

  ps.deckCount = ps.deck.length;
  ps.handCount = ps.hand.length;
  return card;
}

function resetPIForBoth(room) {
  for (const role of ["p1", "p2"]) {
    room.state[role].pi = MAX_PI;
    room.state[role].maxPi = MAX_PI;
  }
}

function gainPAOnBoard(room, role, gain) {
  const ps = room.state[role];
  for (const line of ["front", "back"]) {
    for (let i = 0; i < 5; i++) {
      const card = ps[line][i];
      if (!card) continue;
      const cur = Number.isInteger(card.pa) ? card.pa : 0;
      const maxPa = Number.isInteger(card.maxPa) ? card.maxPa : MAX_CARD_PA;
      card.pa = Math.min(maxPa, cur + gain);
    }
  }
}

function startTurn(room, role, { isGameStart = false } = {}) {
  room.match.activeRole = role;
  room.match.drawnThisTurn[role] = false;

  // compra automática por vez (consome a compra da vez)
  const card = drawOne(room, role);
  room.match.drawnThisTurn[role] = true;

  emitEvent(room, { type: "turnStart", role, round: room.match.round, isGameStart: !!isGameStart });
  if (card) emitEvent(room, { type: "draw", role });
}

function initGameForRoom(room) {
  room.match = {
    activeRole: "p1",
    round: 1,
    drawnThisTurn: { p1: false, p2: false },
  };
  room.state = createNewGameState();

  // montar decks a partir das contas
  for (const p of room.players) {
    const role = p.role;
    const user = usersByName.get(p.username);
    if (!user) throw new Error("User missing at match start");

    const v = Shared.validateDeck(user.deck);
    if (!v.ok) throw new Error(`Deck inválido para ${p.username}: ${v.errors.join(" | ")}`);

    const deckInstances = user.deck.map((dbId) => Shared.instantiateCard(dbId, role)).filter(Boolean);
    Shared.shuffleInPlace(deckInstances);

    const ps = room.state[role];
    ps.username = p.username;

    // mão inicial 5
    ps.hand = deckInstances.splice(0, 5);
    ps.deck = deckInstances;

    ps.handCount = ps.hand.length;
    ps.deckCount = ps.deck.length;

    ps.pi = MAX_PI;
    ps.maxPi = MAX_PI;
  }

  // primeira vez p1: comprar 1 automático
  startTurn(room, "p1", { isGameStart: true });
}

function roomHasTwo(room) { return room && room.players && room.players.length === 2; }

io.on("connection", (socket) => {
  socket.emit("rooms:list", roomsPublicList());

  socket.on("rooms:create", ({ token }) => {
    const username = usersByToken.get(String(token || ""));
    if (!username) return socket.emit("rooms:error", { error: "Você precisa estar logado." });

    const user = usersByName.get(username);
    const v = Shared.validateDeck(user?.deck || []);
    if (!v.ok) return socket.emit("rooms:error", { error: "Deck inválido. Monte um deck (20-50) para jogar.", errors: v.errors });

    const id = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms.set(id, { id, players: [], match: null, state: null });
    io.emit("rooms:list", roomsPublicList());
  });

  socket.on("rooms:join", ({ roomId, token }) => {
    const room = getRoom(roomId);
    if (!room) return socket.emit("rooms:error", { error: "Sala não existe." });
    if (room.players.length >= 2) return socket.emit("rooms:error", { error: "Sala cheia." });

    const username = usersByToken.get(String(token || ""));
    if (!username) return socket.emit("rooms:error", { error: "Você precisa estar logado." });

    const user = usersByName.get(username);
    const v = Shared.validateDeck(user?.deck || []);
    if (!v.ok) return socket.emit("rooms:error", { error: "Deck inválido. Monte um deck (20-50) para jogar.", errors: v.errors });

    // evita mesmo usuário entrar 2x
    if (room.players.some(p => p.username === username)) {
      return socket.emit("rooms:error", { error: "Esse usuário já está na sala." });
    }

    socket.join(roomId);
    const role = room.players.length === 0 ? "p1" : "p2";
    room.players.push({ socketId: socket.id, role, username });

    // start match
    if (room.players.length === 2) {
      try {
        initGameForRoom(room);
      } catch (e) {
        // reset room if bad decks
        room.match = null;
        room.state = null;
        room.players.forEach(p => io.to(p.socketId).emit("rooms:error", { error: String(e.message || e) }));
        room.players = [];
        io.emit("rooms:list", roomsPublicList());
        return;
      }

      room.players.forEach((p) => {
        io.to(p.socketId).emit("match:start", { roomId: room.id, role: p.role, username: p.username });
      });

      sendSync(room);
    }

    io.emit("rooms:list", roomsPublicList());
  });

  socket.on("game:intent", ({ roomId, token, intent }) => {
    const room = getRoom(roomId);
    if (!room || !roomHasTwo(room) || !room.state || !room.match) return;

    const username = usersByToken.get(String(token || ""));
    if (!username) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.username !== username) return;
    const role = player.role;

    if (!intent || !intent.type) return;

    if (intent.type === "endTurn") {
      if (room.match.activeRole !== role) return;

      gainPAOnBoard(room, role, END_TURN_PA_GAIN);
      removeExpiredBuffsForRoleEnd(room, role);

      const next = role === "p1" ? "p2" : "p1";
      if (role === "p2") {
        room.match.round += 1;
        resetPIForBoth(room);
      }
      startTurn(room, next);

      sendSync(room);
      return;
    }

    if (intent.type === "drawCard") {
      if (room.match.activeRole !== role) return;
      if (room.match.drawnThisTurn[role]) return;

      drawOne(room, role);
      room.match.drawnThisTurn[role] = true;

      emitEvent(room, { type: "draw", role });
      sendSync(room);
      return;
    }

    if (intent.type === "playCard") {
      if (room.match.activeRole !== role) return;

      const { line, index, handIndex } = intent;
      if (!isValidLine(line) || !isValidIndex(index)) return;
      if (!Number.isInteger(handIndex) || handIndex < 0) return;

      const ps = room.state[role];
      if (ps[line][index] !== null) return;
      if (handIndex >= ps.hand.length) return;

      const card = ps.hand[handIndex];
      if (!card) return;

      const cost = Number.isInteger(card.piCost) ? card.piCost : (Number.isInteger(card.stars) ? card.stars : 1);
      if (ps.pi < cost) return;

      ps.pi -= cost;

      ps.hand.splice(handIndex, 1);
      ps.handCount = ps.hand.length;

      ps[line][index] = card;

      emitEvent(room, { type: "summon", role, to: { line, index } });
      sendSync(room);
      return;
    }


    if (intent.type === "useHab") {
      if (room.match.activeRole !== role) return;

      const { from, target } = intent;
      if (!from) return;
      if (!isValidLine(from.line) || !isValidIndex(from.index)) return;

      // target is optional, but if present validate structure
      let t = null;
      if (target && target.pos && isValidLine(target.pos.line) && isValidIndex(target.pos.index)) {
        const tr = target.role === "p1" || target.role === "p2" ? target.role : null;
        if (tr) t = { role: tr, pos: { line: target.pos.line, index: target.pos.index } };
      }

      const res = applyHab(room, role, { line: from.line, index: from.index }, t);
      if (!res.ok) return;

      emitEvent(room, { type: "hab", ...res });
      sendSync(room);
      return;
    }

    
    if (intent.type === "useUlt") {
      if (room.match.activeRole !== role) return;

      const { from, target } = intent;
      if (!from) return;
      if (!isValidLine(from.line) || !isValidIndex(from.index)) return;

      let t = null;
      if (target && target.pos && isValidLine(target.pos.line) && isValidIndex(target.pos.index)) {
        const tr = target.role === "p1" || target.role === "p2" ? target.role : null;
        if (tr) t = { role: tr, pos: { line: target.pos.line, index: target.pos.index } };
      }

      const res = applyUlt(room, role, { line: from.line, index: from.index }, t);
      if (!res.ok) return;

      emitEvent(room, { type: "ult", ...res });
      if (res.deaths && res.deaths.length) emitEvent(room, { type: "death", deaths: res.deaths });
      sendSync(room);
      return;
    }

if (intent.type === "attack") {
      if (room.match.activeRole !== role) return;

      const enemy = enemyRoleOf(role);
      const { from, to } = intent;
      if (!from || !to) return;
      if (!isValidLine(from.line) || !isValidIndex(from.index)) return;
      if (!isValidLine(to.line) || !isValidIndex(to.index)) return;

      const me = room.state[role];
      const opp = room.state[enemy];

      const attacker = me[from.line][from.index];
      const target = opp[to.line][to.index];
      if (!attacker || !target) return;

      const pa = Number.isInteger(attacker.pa) ? attacker.pa : 0;
      if (pa < ATTACK_PA_COST) return;

      if (to.line === "back") {
        if (!canAttackBack(attacker, room, enemy)) return;
      }

      attacker.pa = pa - ATTACK_PA_COST;

      const atk = Number.isInteger(attacker.atk) ? attacker.atk : 0;
      const def = Number.isInteger(target.def) ? target.def : 0;
      const raw = atk - def;

      let dmgToTarget = 0;
      let dmgToAttacker = 0;
      let playerDmgToEnemy = 0;
      let playerDmgToMe = 0;

      if (raw > 0) {
        dmgToTarget = raw;
        target.hp = (Number.isInteger(target.hp) ? target.hp : 0) - dmgToTarget;
        playerDmgToEnemy = applyPlayerDamageFromCardHit(room, enemy, dmgToTarget);
      } else if (raw < 0) {
        dmgToAttacker = Math.abs(raw);
        attacker.hp = (Number.isInteger(attacker.hp) ? attacker.hp : 0) - dmgToAttacker;
        playerDmgToMe = applyPlayerDamageFromCardHit(room, role, dmgToAttacker);
      }

      const deaths = [];

      if ((Number.isInteger(target.hp) ? target.hp : 0) <= 0) {
        deaths.push({ role: enemy, from: { line: to.line, index: to.index }, card: { ...target, hp: 0 } });
        opp.graveyard.push({ ...target, hp: 0 });
        opp[to.line][to.index] = null;
      }

      if ((Number.isInteger(attacker.hp) ? attacker.hp : 0) <= 0) {
        deaths.push({ role, from: { line: from.line, index: from.index }, card: { ...attacker, hp: 0 } });
        me.graveyard.push({ ...attacker, hp: 0 });
        me[from.line][from.index] = null;
      }

      emitEvent(room, { type: "attack", role, from: { line: from.line, index: from.index }, to: { line: to.line, index: to.index }, dmgToTarget, dmgToAttacker, playerDmgToEnemy, playerDmgToMe });
      if (deaths.length) emitEvent(room, { type: "death", deaths });

      sendSync(room);
      return;
    }
  });

  socket.on("disconnect", () => {
    for (const [id, room] of rooms) {
      const i = room.players.findIndex((p) => p.socketId === socket.id);
      if (i !== -1) {
        room.players.splice(i, 1);
        if (room.players.length === 0) rooms.delete(id);
        io.emit("rooms:list", roomsPublicList());
        break;
      }
    }
  });
});

server.listen(3000, () => console.log("Rodando na porta 3000"));
