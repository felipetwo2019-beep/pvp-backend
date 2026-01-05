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
    teamEffects: [],
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
  if (t === "Melee" || t === "Tank") {
    const owner = attackerCard?.owner;
    const teamEffects = owner ? getTeamEffects(room.state[owner], "l18_backrow_access") : [];
    if (teamEffects.length > 0) return true;
    return !frontHasAny(room, enemyRole);
  }
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

function checkGameOver(room){
  if (!room?.match) return null;
  if (room.match.winner) return room.match.winner;
  const p1Hp = room.state.p1.playerHp ?? PLAYER_START_HP;
  const p2Hp = room.state.p2.playerHp ?? PLAYER_START_HP;
  if (p1Hp <= 0) room.match.winner = "p2";
  if (p2Hp <= 0) room.match.winner = "p1";
  return room.match.winner || null;
}

function emitGameOver(room){
  const winner = checkGameOver(room);
  if (!winner) return false;
  emitEvent(room, { type: "gameOver", winner, loser: winner === "p1" ? "p2" : "p1" });
  return true;
}


// ===== Abilities / Status Effects =====
const HAB_COST_PA = 3;
const ULT_COST_PA = 5;

function cardKey(room, role){
  return `${room.match.turnCounter}:${role}`;
}

function ensureCardState(card){
  if (!card) return;
  if (!Array.isArray(card.statusEffects)) card.statusEffects = [];
  if (!Number.isInteger(card.shield)) card.shield = 0;
}

function addStatusEffect(card, effect){
  if (!card) return;
  ensureCardState(card);
  card.statusEffects = card.statusEffects.filter(e => e.id !== effect.id);
  card.statusEffects.push({ ...effect });
  if (effect.type === "shield") {
    const val = Number.isFinite(effect.value) ? effect.value : 0;
    card.shield = Math.max(0, (card.shield || 0) + val);
  }
}

function removeStatusEffect(card, effect){
  if (!card || !effect) return;
  ensureCardState(card);
  if (effect.type === "shield") {
    const val = Number.isFinite(effect.value) ? effect.value : 0;
    card.shield = Math.max(0, (card.shield || 0) - val);
  }
  card.statusEffects = card.statusEffects.filter(e => e !== effect);
}

function addTeamEffect(ps, effect){
  if (!ps) return;
  if (!Array.isArray(ps.teamEffects)) ps.teamEffects = [];
  ps.teamEffects = ps.teamEffects.filter(e => e.id !== effect.id);
  ps.teamEffects.push({ ...effect });
}

function getTeamEffects(ps, type){
  const effects = Array.isArray(ps?.teamEffects) ? ps.teamEffects : [];
  return effects.filter(e => e.turnsLeft > 0 && (!type || e.type === type));
}

function isSuppressed(room, role){
  const ps = room.state[role];
  return getTeamEffects(ps, "suppress_temp_effects").length > 0;
}

function getActiveEffects(room, card, type){
  ensureCardState(card);
  const suppressed = card?.owner ? isSuppressed(room, card.owner) : false;
  let effects = card.statusEffects.filter(e => e.turnsLeft > 0);
  if (suppressed) {
    effects = effects.filter(e => e?.meta?.ignoreSuppression || e?.meta?.permanent);
  }
  if (type) effects = effects.filter(e => e.type === type);
  return effects;
}

function getUtilityMultiplierForSide(room, role){
  const ps = room.state[role];
  const hasDouble = getTeamEffects(ps, "l14_util_double").length > 0;
  return hasDouble ? 2 : 1;
}

function getEffectiveDef(room, card){
  const defOverride = getActiveEffects(room, card, "def_override");
  if (defOverride.length > 0) return 0;
  return Number.isInteger(card?.def) ? card.def : 0;
}

function getEffectiveAtk(room, card){
  const baseAtk = Number.isInteger(card?.atk) ? card.atk : 0;
  const flat = getActiveEffects(room, card, "atk_flat").reduce((sum, e) => sum + (e.value || 0), 0);
  const missingEffects = getActiveEffects(room, card, "atk_missing_hp");
  let missingBonus = 0;
  for (const e of missingEffects){
    const perHp = e.meta?.perHp ?? 30;
    const bonus = e.meta?.bonus ?? 10;
    const missing = Math.max(0, (card.maxHp ?? 0) - (card.hp ?? 0));
    missingBonus += Math.floor(missing / perHp) * bonus;
  }
  let tribeBonus = 0;
  for (const e of getActiveEffects(room, card, "atk_per_tribe")){
    const tribe = e.meta?.tribe;
    const per = e.meta?.per ?? e.value ?? 0;
    const owner = e.meta?.owner ?? card.owner;
    if (!owner || !tribe) continue;
    const ps = room.state[owner];
    const count = ["front","back"].reduce((sum, line) => sum + ps[line].filter(c => c && c.tribe === tribe).length, 0);
    tribeBonus += count * per;
  }
  let mult = 1;
  for (const e of getActiveEffects(room, card, "atk_mult")){
    mult *= (e.value || 1);
  }
  const teamMult = getTeamEffects(room.state[card.owner], "atk_mult");
  for (const e of teamMult) mult *= (e.value || 1);
  for (const e of getActiveEffects(room, card, "atk_shield_mult")){
    const perShield = e.meta?.perShield ?? 20;
    const bonusPct = e.meta?.bonusPct ?? 0;
    const shieldBonus = Math.floor((card.shield || 0) / perShield) * bonusPct;
    mult *= (e.value || 1) + shieldBonus;
  }
  for (const e of getActiveEffects(room, card, "l16_dice")){
    const atkMult = e.meta?.atkMult ?? 1;
    mult *= atkMult;
  }
  return Math.max(0, Math.floor((baseAtk + flat + missingBonus + tribeBonus) * mult));
}

function getDamageReduction(room, card){
  const reductions = getActiveEffects(room, card, "damage_reduction").map(e => e.value || 0);
  const total = reductions.reduce((sum, v) => sum + v, 0);
  return Math.min(0.9, Math.max(0, total));
}

function hasDamageImmunity(room, card){
  return getActiveEffects(room, card, "damage_immunity").length > 0;
}

function getDamageTakenMultiplier(room, card){
  const mults = [
    ...getActiveEffects(room, card, "damage_taken_mult"),
    ...getActiveEffects(room, card, "l15_runa"),
  ].map(e => e.value || 1);
  return mults.reduce((m, v) => m * v, 1);
}

function isPacifist(room, card){
  return getActiveEffects(room, card, "pacifist").length > 0;
}

function canUseAction(room, card, actionType){
  const key = cardKey(room, card.owner);
  if (!card.turnActionUses || card.turnActionUses.key !== key){
    card.turnActionUses = { key, skill: 0, ult: 0 };
  }
  const limit = (card.dbId === "L-11" && actionType === "skill") ? 2 : 1;
  if (card.turnActionUses[actionType] >= limit) return false;
  card.turnActionUses[actionType] += 1;
  return true;
}

function getActionCost(card, actionType){
  if (actionType === "skill") {
    if (card.dbId === "L-11") return 1;
    return HAB_COST_PA;
  }
  if (actionType === "ult") {
    if (card.dbId === "L-14") return 6;
    return ULT_COST_PA;
  }
  return ATTACK_PA_COST;
}

function findCardPosition(room, role, instanceId){
  const ps = room.state[role];
  for (const line of ["front","back"]){
    for (let i=0;i<5;i++){
      const c = ps[line][i];
      if (c?.instanceId === instanceId) return { line, index: i };
    }
  }
  return null;
}

function findCardField(room, card){
  if (!card?.owner) return null;
  return findCardPosition(room, card.owner, card.instanceId);
}

function isSupportAction(card, actionType){
  const supportMap = {
    "L-1": ["skill"],
    "L-2": ["skill","ult"],
    "L-3": ["skill","ult"],
    "L-4": ["skill","ult"],
    "L-5": ["ult"],
    "L-6": ["skill","ult"],
    "L-7": ["skill","ult"],
    "L-8": ["skill","ult"],
    "L-9": ["skill"],
    "L-10": ["skill","ult"],
    "L-11": ["skill","ult"],
    "L-12": ["ult"],
    "L-13": ["skill","ult"],
    "L-14": ["skill","ult"],
    "L-15": ["ult"],
    "L-16": ["skill","ult"],
    "L-17": ["skill","ult"],
    "L-18": ["skill","ult"],
    "L-19": ["skill","ult"],
  };
  return supportMap[card.dbId]?.includes(actionType);
}

function decrementStatusEffectsForRole(room, role){
  const ps = room.state[role];
  for (const line of ["front","back"]){
    for (let i=0;i<5;i++){
      const card = ps[line][i];
      if (!card) continue;
      ensureCardState(card);
      for (const effect of [...card.statusEffects]){
        if (effect?.meta?.permanent) continue;
        effect.turnsLeft = Math.max(0, (effect.turnsLeft ?? 0) - 1);
        if (effect.turnsLeft <= 0) {
          removeStatusEffect(card, effect);
        }
      }
    }
  }
  if (Array.isArray(ps.teamEffects)){
    ps.teamEffects = ps.teamEffects.filter(e => {
      if (e?.meta?.permanent) return true;
      e.turnsLeft = Math.max(0, (e.turnsLeft ?? 0) - 1);
      return e.turnsLeft > 0;
    });
  }
}

function applyStartTurnEffects(room, role){
  const ps = room.state[role];
  if (!ps) return;
  const teamPaBonus = getTeamEffects(ps, "pa_bonus_start");
  const teamPaBonusValue = teamPaBonus.reduce((sum, e) => sum + (e.value || 0), 0);
  for (const line of ["front","back"]){
    for (let i=0;i<5;i++){
      const card = ps[line][i];
      if (!card) continue;
      ensureCardState(card);
      const cardPaBonus = getActiveEffects(room, card, "pa_bonus_start_card")
        .filter(e => !e.filters?.targetUid || e.filters?.targetUid === card.instanceId)
        .reduce((sum, e) => sum + (e.value || 0), 0);
      const total = teamPaBonusValue + cardPaBonus;
      if (total > 0) {
        const maxPa = Number.isInteger(card.maxPa) ? card.maxPa : MAX_CARD_PA;
        card.pa = Math.min(maxPa, (card.pa ?? 0) + total);
      }
      for (const effect of getActiveEffects(room, card, "hp_drain_pct")){
        const drain = Math.floor((card.maxHp ?? 0) * (effect.value || 0));
        card.hp = Math.max(0, (card.hp ?? 0) - drain);
      }
      for (const effect of getActiveEffects(room, card, "infection")){
        const dmg = Math.floor(effect.value || 0);
        card.hp = Math.max(0, (card.hp ?? 0) - dmg);
      }
    }
  }
}

function cleanupDeadCards(room, role){
  const ps = room.state[role];
  if (!ps) return [];
  const deaths = [];
  for (const line of ["front","back"]){
    for (let i=0;i<5;i++){
      const card = ps[line][i];
      if (card && (card.hp ?? 0) <= 0) {
        deaths.push({ role, from: { line, index: i }, card: { ...card, hp: 0 } });
        ps.graveyard.push({ ...card, hp: 0 });
        ps[line][i] = null;
      }
    }
  }
  return deaths;
}

function handleControlRelease(room){
  for (const role of ["p1","p2"]){
    const ps = room.state[role];
    for (const line of ["front","back"]){
      for (let i=0;i<5;i++){
        const card = ps[line][i];
        if (!card?.controlReleaseTurn) continue;
        if (room.match.turnCounter < card.controlReleaseTurn) continue;
        const origin = card.controlOrigin;
        const originalOwner = origin?.owner;
        if (!originalOwner) {
          card.controlReleaseTurn = null;
          card.controlledBy = null;
          continue;
        }
        const targetPs = room.state[originalOwner];
        let place = origin?.pos;
        if (!place || targetPs[place.line][place.index]) {
          place = null;
          for (const ln of ["front","back"]){
            for (let idx=0; idx<5; idx++){
              if (!targetPs[ln][idx]) { place = { line: ln, index: idx }; break; }
            }
            if (place) break;
          }
        }
        if (!place) continue;
        ps[line][i] = null;
        card.owner = originalOwner;
        targetPs[place.line][place.index] = card;
        card.controlledBy = null;
        card.controlReleaseTurn = null;
        card.controlMoved = false;
      }
    }
  }
}

function canTargetBackRow(room, source, targetRole){
  const enemyRole = targetRole;
  const enemy = room.state[enemyRole];
  if (!enemy.front.some(c => c !== null)) return true;
  const t = String(source?.type || "").toUpperCase();
  if (t === "RANGED" || t === "SUPPORT") return true;
  const teamBackRow = getTeamEffects(room.state[source.owner], "l18_backrow_access");
  return teamBackRow.length > 0;
}

function applyDamageToCard(room, source, targetRole, targetPos, amount, options = {}){
  const targetPs = room.state[targetRole];
  if (!targetPs) return { dmg: 0, deaths: [] };
  let target = targetPs[targetPos.line]?.[targetPos.index];
  if (!target) return { dmg: 0, deaths: [] };
  ensureCardState(target);

  const intercepts = getActiveEffects(room, target, "intercept");
  if (intercepts.length > 0) {
    const interceptorId = intercepts[0].meta?.sourceInstanceId;
    const pos = interceptorId ? findCardPosition(room, target.owner, interceptorId) : null;
    if (pos) {
      targetPos = pos;
      target = targetPs[pos.line][pos.index];
      ensureCardState(target);
    }
  }

  let finalDmg = Math.max(0, amount);
  if (source && isPacifist(room, source)) finalDmg = 0;
  if (hasDamageImmunity(room, target)) finalDmg = 0;
  finalDmg *= getDamageTakenMultiplier(room, target);
  const reduction = getDamageReduction(room, target);
  if (reduction > 0) finalDmg *= (1 - reduction);
  finalDmg = Math.max(0, Math.floor(finalDmg));

  if (finalDmg > 0 && !options.skipRedirect) {
    const redirect = getActiveEffects(room, target, "damage_redirect_skeletons");
    if (redirect.length > 0) {
      const owner = target.owner;
      const ownerPs = room.state[owner];
      const skeletons = ["front","back"].flatMap(line =>
        ownerPs[line].filter(c => c && c.instanceId !== target.instanceId && c.tribe === "Esqueletos")
      );
      if (skeletons.length > 0) {
        const redirectTotal = finalDmg * 0.2;
        const per = redirectTotal / skeletons.length;
        finalDmg -= redirectTotal;
        for (const skel of skeletons) {
          const pos = findCardPosition(room, owner, skel.instanceId);
          if (pos) {
            applyDamageToCard(room, source, owner, pos, per, { skipRedirect: true, skipReflect: true, isSplash: true });
          }
        }
      }
    }
  }

  if (finalDmg > 0 && target.shield > 0) {
    const absorbed = Math.min(target.shield, finalDmg);
    target.shield -= absorbed;
    finalDmg -= absorbed;
  }

  if (finalDmg > 0) {
    target.hp = Math.max(0, (target.hp ?? 0) - finalDmg);
  }

  const deaths = [];
  if ((target.hp ?? 0) <= 0) {
    deaths.push({ role: targetRole, from: { line: targetPos.line, index: targetPos.index }, card: { ...target, hp: 0 } });
    targetPs.graveyard.push({ ...target, hp: 0 });
    targetPs[targetPos.line][targetPos.index] = null;
  }
  return { dmg: finalDmg, deaths, resolvedTarget: { role: targetRole, pos: targetPos, card: target } };
}

function handlePaSteal(room, source, targetCard){
  if (!source || !targetCard || targetCard.pa <= 0) return;
  const removePa = () => {
    targetCard.pa = Math.max(0, (targetCard.pa ?? 0) - 1);
  };
  const guaranteed = getActiveEffects(room, source, "next_attack_steal_pa");
  if (guaranteed.length > 0) {
    removePa();
    source.statusEffects = source.statusEffects.filter(e => e.type !== "next_attack_steal_pa");
    return;
  }
  const teamEffects = getTeamEffects(room.state[source.owner], "pa_steal_on_damage");
  if (teamEffects.length > 0) {
    const chance = Math.max(...teamEffects.map(e => e.chance ?? 0));
    if (Math.random() < chance) removePa();
  }
}

function executeSupportAction(room, actionType, source, target){
  const owner = room.state[source.owner];
  const utilMult = getUtilityMultiplierForSide(room, source.owner);
  const effectTarget = target?.card || source;

  if (source.dbId === "L-1" && actionType === "skill") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      if (ally.instanceId === source.instanceId || ally.tribe === "Guerreiro") {
        addStatusEffect(ally, {
          id: `l1_skill_${source.instanceId}_${ally.instanceId}`,
          sourceDbId: source.dbId,
          type: "atk_flat",
          value: 50,
          turnsLeft: 3,
          filters: {},
          meta: {}
        });
      }
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-2" && actionType === "skill") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      if (ally.type === "Ranged" || ally.type === "Support") {
        addStatusEffect(ally, { id:`l2_skill_${source.instanceId}_${ally.instanceId}`, sourceDbId: source.dbId, type:"crit_chance", value:0.2, turnsLeft:2, filters:{}, meta:{} });
      }
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-2" && actionType === "ult") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      addStatusEffect(ally, { id:`l2_ult_${source.instanceId}_${ally.instanceId}`, sourceDbId: source.dbId, type:"crit_chance", value:1, turnsLeft:1, filters:{}, meta:{} });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-3" && actionType === "skill") {
    addStatusEffect(source, { id:`l3_skill_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_missing_hp", value:0, turnsLeft:4, filters:{}, meta:{ perHp:30, bonus:10 } });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-3" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    addStatusEffect(effectTarget, { id:`l3_intercept_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"intercept", value:0, turnsLeft:2, filters:{}, meta:{ sourceInstanceId: source.instanceId } });
    addStatusEffect(source, { id:`l3_reduce_${source.instanceId}`, sourceDbId: source.dbId, type:"damage_reduction", value:0.3, turnsLeft:2, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-4" && actionType === "skill") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      ally.pa = Math.min(10, (ally.pa ?? 0) + 2);
    }
    addTeamEffect(owner, { id:`l4_next_pa_${source.instanceId}_${Date.now()}`, sourceDbId: source.dbId, type:"pa_bonus_start", value:2, turnsLeft:1, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-4" && actionType === "ult") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      const missing = Math.max(0, (ally.maxHp ?? 0) - (ally.hp ?? 0));
      ally.hp = Math.min(ally.maxHp ?? ally.hp, (ally.hp ?? 0) + missing);
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-5" && actionType === "ult") {
    addStatusEffect(source, { id:`l5_ult_def_${source.instanceId}`, sourceDbId: source.dbId, type:"def_override", value:0, turnsLeft:2, filters:{}, meta:{} });
    addStatusEffect(source, { id:`l5_ult_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_mult", value:1.75, turnsLeft:2, filters:{}, meta:{} });
    addStatusEffect(source, { id:`l5_ult_drain_${source.instanceId}`, sourceDbId: source.dbId, type:"hp_drain_pct", value:0.25, turnsLeft:2, filters:{}, meta:{ timing:"start_turn_owner" } });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-6" && actionType === "skill") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      addStatusEffect(ally, { id:`l6_skill_${source.instanceId}_${ally.instanceId}`, sourceDbId: source.dbId, type:"damage_reduction", value:0.1, turnsLeft:2, filters:{}, meta:{} });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-6" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    addStatusEffect(effectTarget, { id:`l6_ult_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"damage_immunity", value:1, turnsLeft:1, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-7" && actionType === "skill") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    const totalHand = room.state.p1.hand.length + room.state.p2.hand.length;
    const bonus = totalHand * 10;
    addStatusEffect(effectTarget, { id:`l7_skill_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:bonus, turnsLeft:2, filters:{ targetUid: effectTarget.instanceId }, meta:{ perHand:10 } });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-7" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    if (effectTarget.owner === source.owner) {
      const healAmount = Math.max(0, (effectTarget.maxHp ?? 0) - (effectTarget.hp ?? 0));
      effectTarget.hp = effectTarget.maxHp ?? effectTarget.hp;
      if (!Number.isFinite(effectTarget.maxHp)) effectTarget.maxHp = effectTarget.hp;
      if (healAmount > 0) effectTarget.hp = effectTarget.maxHp;
    }
    addStatusEffect(effectTarget, { id:`l7_ult_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"pacifist", value:1, turnsLeft: effectTarget.owner === source.owner ? 1 : 2, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-8" && actionType === "skill") {
    const ownerEntity = owner;
    const skeletonsField = ["front","back"].flatMap(line => ownerEntity[line].filter(c => c && c.tribe === "Esqueletos"));
    const skeletonsGy = ownerEntity.graveyard.filter(c => c.tribe === "Esqueletos");
    const bonus = (skeletonsField.length + skeletonsGy.length) * 20;
    addStatusEffect(source, { id:`l8_skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:bonus, turnsLeft:2, filters:{}, meta:{ countField: skeletonsField.length, countGy: skeletonsGy.length } });
    addStatusEffect(source, { id:`l8_skill_redirect_${source.instanceId}`, sourceDbId: source.dbId, type:"damage_redirect_skeletons", value:0.2, turnsLeft:1, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-8" && actionType === "ult") {
    const ownerEntity = owner;
    const bonus = ownerEntity.graveyard.filter(c => c.tribe === "Esqueletos").reduce((sum, c) => sum + (c.atk || 0), 0);
    addStatusEffect(source, { id:`l8_ult_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:bonus, turnsLeft:1, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-9" && actionType === "skill") {
    addStatusEffect(source, { id:`l9_skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_per_tribe", value:20, turnsLeft:2, filters:{}, meta:{ tribe:"Lanceiros", per:20, owner: source.owner } });
    addStatusEffect(source, { id:`l9_spill_${source.instanceId}`, sourceDbId: source.dbId, type:"l9_spill", value:0.3, turnsLeft:2, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-10" && actionType === "skill") {
    addStatusEffect(source, { id:`l10_skill_reduction_${source.instanceId}`, sourceDbId: source.dbId, type:"damage_reduction", value:0.2, turnsLeft:3, filters:{}, meta:{} });
    addStatusEffect(source, { id:`l10_skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_shield_mult", value:1.1, turnsLeft:3, filters:{}, meta:{ perShield:20, bonusPct:0.02 } });
    addStatusEffect(source, { id:`l10_skill_active_${source.instanceId}`, sourceDbId: source.dbId, type:"l10_skill_active", value:1, turnsLeft:3, filters:{}, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-10" && actionType === "ult") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      const shieldValue = Math.floor((ally.maxHp ?? 0) * 0.2);
      addStatusEffect(ally, { id:`l10_ult_shield_${source.instanceId}_${ally.instanceId}`, sourceDbId: source.dbId, type:"shield", value:shieldValue, turnsLeft:2, filters:{}, meta:{} });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-11" && actionType === "skill") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    const targetOwner = room.state[effectTarget.owner];
    const fromPos = findCardPosition(room, effectTarget.owner, effectTarget.instanceId);
    if (!fromPos) return { ok:false, reason:"bad_target" };
    const toLine = fromPos.line === "front" ? "back" : "front";
    const swapCard = targetOwner[toLine][fromPos.index];
    targetOwner[fromPos.line][fromPos.index] = swapCard || null;
    if (swapCard) {
      targetOwner[toLine][fromPos.index] = effectTarget;
    } else {
      targetOwner[toLine][fromPos.index] = effectTarget;
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-11" && actionType === "ult") {
    const drunkId = `l11_drunk_${source.instanceId}`;
    const soberId = `l11_sober_${source.instanceId}`;
    ensureCardState(source);
    const hasDrunk = source.statusEffects.some(e => e.id === drunkId);
    const hasSober = source.statusEffects.some(e => e.id === soberId);
    source.statusEffects = source.statusEffects.filter(e => e.id !== drunkId && e.id !== soberId);
    if (hasDrunk || !hasSober) {
      addStatusEffect(source, { id: soberId, sourceDbId: source.dbId, type:"atk_mult", value:1.25, turnsLeft:1, filters:{}, meta:{ permanent:true } });
    } else {
      addStatusEffect(source, { id: drunkId, sourceDbId: source.dbId, type:"damage_reduction", value:0.25, turnsLeft:1, filters:{}, meta:{ permanent:true } });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-12" && actionType === "ult") {
    const allies = ["front","back"].flatMap(line => owner[line].filter(c => c));
    const enemies = ["front","back"].flatMap(line => room.state[enemyRoleOf(source.owner)][line].filter(c => c));
    const poisonBase = Math.floor(getEffectiveAtk(room, source) * 0.2);
    for (const enemy of enemies) {
      addStatusEffect(enemy, { id:`l12_ult_infect_${source.instanceId}_${enemy.instanceId}`, sourceDbId: source.dbId, type:"infection", value:poisonBase, turnsLeft:2, filters:{}, meta:{ sourceInstanceId: source.instanceId } });
    }
    for (const ally of allies) {
      const heal = Math.floor((ally.maxHp ?? 0) * 0.2);
      ally.hp = Math.min(ally.maxHp ?? ally.hp, (ally.hp ?? 0) + heal);
    }
    const buffTarget = effectTarget || source;
    const bonus = allies.length * 20;
    addStatusEffect(buffTarget, { id:`l12_ult_buff_${source.instanceId}_${buffTarget.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:bonus, turnsLeft:2, filters:{ targetUid: buffTarget.instanceId }, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-13" && actionType === "skill") {
    const originRole = target?.role || source.owner;
    const origin = room.state[originRole];
    const targetCard = target?.graveyardCard || origin.graveyard[0];
    if (!targetCard) return { ok:false, reason:"no_target" };
    if (!["COMMON","RARE","EPIC"].includes(String(targetCard.rarity || "").toUpperCase())) return { ok:false, reason:"rarity" };
    const necroCount = ["front","back"].flatMap(line => owner[line].filter(c => c?.isNecroSummon)).length;
    if (necroCount >= 2) return { ok:false, reason:"limit" };
    const place = ["front","back"].flatMap(line => owner[line].map((c, idx) => ({ line, idx, c }))).find(s => !s.c);
    if (!place) return { ok:false, reason:"no_space" };
    const idx = origin.graveyard.findIndex(c => c.instanceId === targetCard.instanceId);
    if (idx !== -1) origin.graveyard.splice(idx, 1);
    const summoned = { ...targetCard, owner: source.owner, isNecroSummon: true, necromancerId: source.instanceId, necroOriginalOwner: targetCard.owner || originRole };
    addStatusEffect(summoned, { id:`l13_necro_${source.instanceId}_${summoned.instanceId}`, sourceDbId: source.dbId, type:"necro_control", value:0, turnsLeft:99, filters:{}, meta:{} });
    owner[place.line][place.idx] = summoned;
    return { ok:true, support:true };
  }
  if (source.dbId === "L-13" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    if (effectTarget.controlImmune || effectTarget.controlledBy) return { ok:false, reason:"control_immune" };
    const originPos = findCardPosition(room, effectTarget.owner, effectTarget.instanceId);
    if (!originPos) return { ok:false, reason:"bad_target" };
    effectTarget.controlledBy = source.owner;
    effectTarget.controlOrigin = { owner: effectTarget.owner, pos: originPos };
    effectTarget.controlReleaseTurn = room.match.turnCounter + 2;
    effectTarget.controlImmune = true;
    const controller = owner;
    const spot = ["front","back"].flatMap(line => controller[line].map((c, idx) => ({ line, idx, c }))).find(s => !s.c);
    if (spot) {
      room.state[enemyRoleOf(source.owner)][originPos.line][originPos.index] = null;
      effectTarget.owner = source.owner;
      effectTarget.controlMoved = true;
      controller[spot.line][spot.idx] = effectTarget;
    }
    addStatusEffect(effectTarget, { id:`l13_control_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"mind_control", value:1, turnsLeft:2, filters:{}, meta:{ controller: source.owner } });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-14" && actionType === "skill") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    addTeamEffect(owner, { id:`l14_util_double_${source.owner}`, sourceDbId: source.dbId, type:"l14_util_double", value:2, turnsLeft:2, filters:{}, meta:{ sourceSide: source.owner } });
    const paGain = 2 * utilMult;
    effectTarget.pa = Math.min(10, (effectTarget.pa ?? 0) + paGain);
    addStatusEffect(effectTarget, { id:`l14_pa_boost_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"pa_bonus_start_card", value:paGain, turnsLeft:1, filters:{ targetUid: effectTarget.instanceId }, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-14" && actionType === "ult") {
    const enemy = room.state[enemyRoleOf(source.owner)];
    addTeamEffect(enemy, { id:`l14_suppress_${source.instanceId}_${Date.now()}`, sourceDbId: source.dbId, type:"suppress_temp_effects", value:1, turnsLeft:2, filters:{}, meta:{ sourceSide: source.owner } });
    for (const enemyCard of ["front","back"].flatMap(line => enemy[line].filter(c => c))) {
      addStatusEffect(enemyCard, { id:`l14_vuln_${source.instanceId}_${enemyCard.instanceId}`, sourceDbId: source.dbId, type:"damage_taken_mult", value:1.25, turnsLeft:2, filters:{}, meta:{ ignoreSuppression:true } });
    }
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      const shieldValue = Math.floor((ally.maxHp ?? 0) * 0.1);
      addStatusEffect(ally, { id:`l14_shield_${source.instanceId}_${ally.instanceId}`, sourceDbId: source.dbId, type:"shield", value:shieldValue, turnsLeft:2, filters:{}, meta:{} });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-15" && actionType === "ult") {
    const enemy = room.state[enemyRoleOf(source.owner)];
    const runeTargets = ["front","back"].flatMap(line => enemy[line].filter(c => c && getActiveEffects(room, c, "l15_runa").length > 0));
    if (runeTargets.length === 0) return { ok:false, reason:"no_runes" };
    let defPct = 0.25;
    let atkPct = 0.25;
    if (runeTargets.length === 1) { defPct = 1; atkPct = 0.5; }
    else if (runeTargets.length === 2) { defPct = 0.75; atkPct = 0.35; }
    else if (runeTargets.length === 3) { defPct = 0.5; atkPct = 0.3; }
    for (const targetCard of runeTargets) {
      const defLoss = Math.floor((targetCard.def ?? 0) * defPct);
      const atkLoss = Math.floor((targetCard.atk ?? 0) * atkPct);
      targetCard.def = Math.max(0, (targetCard.def ?? 0) - defLoss);
      targetCard.atk = Math.max(0, (targetCard.atk ?? 0) - atkLoss);
      source.atk = (source.atk ?? 0) + atkLoss;
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-16" && actionType === "skill") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    const roll = Math.floor(Math.random() * 6) + 1;
    const healChance = roll * 0.1;
    const atkMult = 1 + (roll * 0.05);
    addStatusEffect(effectTarget, { id:`l16_dice_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"l16_dice", value:0, turnsLeft:1, filters:{ targetUid: effectTarget.instanceId }, meta:{ roll, healChance, atkMult } });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-16" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    const suit = target?.suit || ["swords","hearts","gold","clubs"][Math.floor(Math.random() * 4)];
    addStatusEffect(source, { id:`l16_suit_${source.instanceId}`, sourceDbId: source.dbId, type:"l16_suit_badge", value:0, turnsLeft:1, filters:{}, meta:{ label: suit, icon: suit } });
    if (suit === "swords") {
      addStatusEffect(effectTarget, { id:`l16_swords_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"atk_mult", value:1.75, turnsLeft:1, filters:{ targetUid: effectTarget.instanceId }, meta:{} });
    }
    if (suit === "hearts") {
      const healAmount = Math.floor((effectTarget.maxHp ?? 0) * 0.75 * utilMult);
      effectTarget.hp = Math.min(effectTarget.maxHp ?? effectTarget.hp, (effectTarget.hp ?? 0) + healAmount);
    }
    if (suit === "gold") {
      const enemyEntity = room.state[enemyRoleOf(source.owner)];
      for (const enemy of ["front","back"].flatMap(line => enemyEntity[line].filter(c => c))) {
        enemy.statusEffects = enemy.statusEffects?.filter(e => e.type !== "atk_mult") || [];
        addStatusEffect(enemy, { id:`l16_gold_${source.instanceId}_${enemy.instanceId}`, sourceDbId: source.dbId, type:"atk_mult", value:0.85, turnsLeft:1, filters:{}, meta:{} });
      }
    }
    if (suit === "clubs") {
      const paGain = 2 * utilMult;
      for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
        ally.pa = Math.min(10, (ally.pa ?? 0) + paGain);
      }
      addTeamEffect(owner, { id:`l16_clubs_next_${source.instanceId}_${Date.now()}`, sourceDbId: source.dbId, type:"pa_bonus_start", value:paGain, turnsLeft:1, filters:{}, meta:{ sourceSide: source.owner } });
    }
    return { ok:true, support:true, suit };
  }
  if (source.dbId === "L-17" && actionType === "skill") {
    drawOne(room, source.owner);
    return { ok:true, support:true };
  }
  if (source.dbId === "L-17" && actionType === "ult") {
    const opponent = enemyRoleOf(source.owner);
    drawOne(room, opponent);
    const oppState = room.state[opponent];
    const steals = Math.min(2, oppState.hand.length);
    for (let i=0;i<steals;i++){
      const idx = Math.floor(Math.random() * oppState.hand.length);
      const stolen = oppState.hand.splice(idx, 1)[0];
      if (stolen) {
        stolen.owner = source.owner;
        owner.hand.push(stolen);
      }
    }
    oppState.handCount = oppState.hand.length;
    owner.handCount = owner.hand.length;
    return { ok:true, support:true };
  }
  if (source.dbId === "L-18" && actionType === "skill") {
    addTeamEffect(owner, { id:`l18_vanguard_atk_${source.owner}`, sourceDbId: source.dbId, type:"atk_mult", value:1.2, turnsLeft:2, filters:{ owner: source.owner }, meta:{} });
    addTeamEffect(owner, { id:`l18_vanguard_back_${source.owner}`, sourceDbId: source.dbId, type:"l18_backrow_access", value:1, turnsLeft:2, filters:{ owner: source.owner }, meta:{} });
    if (effectTarget) {
      effectTarget.pa = Math.min(10, (effectTarget.pa ?? 0) + 2);
      addStatusEffect(effectTarget, { id:`l18_vanguard_pa_${source.instanceId}_${effectTarget.instanceId}`, sourceDbId: source.dbId, type:"pa_bonus_start_card", value:2, turnsLeft:1, filters:{ targetUid: effectTarget.instanceId }, meta:{} });
    }
    return { ok:true, support:true };
  }
  if (source.dbId === "L-18" && actionType === "ult") {
    if (!effectTarget) return { ok:false, reason:"need_target" };
    const enemyRole = enemyRoleOf(source.owner);
    const enemyState = room.state[enemyRole];
    const targetPos = findCardPosition(room, enemyRole, effectTarget.instanceId);
    if (targetPos) {
      enemyState[targetPos.line][targetPos.index] = null;
      enemyState.deck.unshift(effectTarget);
    }
    if (enemyState.hand.length > 0) {
      const idx = Math.floor(Math.random() * enemyState.hand.length);
      const picked = enemyState.hand.splice(idx, 1)[0];
      if (picked) enemyState.deck.push(picked);
    }
    if (enemyState.graveyard.length > 0) {
      const idx = Math.floor(Math.random() * enemyState.graveyard.length);
      const picked = enemyState.graveyard.splice(idx, 1)[0];
      if (picked) {
        picked.owner = source.owner;
        owner.graveyard.push(picked);
      }
    }
    enemyState.handCount = enemyState.hand.length;
    enemyState.deckCount = enemyState.deck.length;
    return { ok:true, support:true };
  }
  if (source.dbId === "L-19" && actionType === "skill") {
    for (const ally of ["front","back"].flatMap(line => owner[line].filter(c => c))) {
      ally.pa = Math.min(10, (ally.pa ?? 0) + 1);
    }
    addTeamEffect(owner, { id:`l19_rhythm_pa_${source.instanceId}`, sourceDbId: source.dbId, type:"pa_bonus_start", value:2, turnsLeft:1, filters:{ owner: source.owner }, meta:{} });
    addTeamEffect(owner, { id:`l19_rhythm_steal_${source.instanceId}`, sourceDbId: source.dbId, type:"pa_steal_on_damage", chance:0.1, turnsLeft:2, filters:{ owner: source.owner }, meta:{} });
    return { ok:true, support:true };
  }
  if (source.dbId === "L-19" && actionType === "ult") {
    addStatusEffect(source, { id:`l19_next_attack_${source.instanceId}`, sourceDbId: source.dbId, type:"next_attack_steal_pa", value:1, turnsLeft:2, filters:{}, meta:{} });
    addTeamEffect(owner, { id:`l19_ult_steal_${source.instanceId}`, sourceDbId: source.dbId, type:"pa_steal_on_damage", chance:0.4, turnsLeft:1, filters:{ owner: source.owner }, meta:{} });
    return { ok:true, support:true };
  }
  return { ok:false, reason:"unsupported" };
}

function applyAction(room, role, from, target, actionType){
  const ps = room.state[role];
  if (!ps) return { ok:false, reason:"no_player" };
  const source = ps[from.line]?.[from.index];
  if (!source) return { ok:false, reason:"no_card" };
  source.owner = role;
  ensureCardState(source);
  const cost = getActionCost(source, actionType);
  if ((source.pa ?? 0) < cost) return { ok:false, reason:"no_pa" };
  if (!canUseAction(room, source, actionType)) return { ok:false, reason:"cooldown" };
  let resolvedTarget = null;
  if (target?.role && target?.pos) {
    const targetCard = room.state[target.role]?.[target.pos.line]?.[target.pos.index];
    if (targetCard) resolvedTarget = { role: target.role, pos: target.pos, card: targetCard };
  }
  if (target?.role && Number.isInteger(target.graveyardIndex)) {
    const gyCard = room.state[target.role]?.graveyard?.[target.graveyardIndex] || null;
    resolvedTarget = { role: target.role, graveyardCard: gyCard };
  }
  if (target?.role && target?.instanceId) {
    const gyCard = room.state[target.role]?.graveyard?.find(c => c.instanceId === target.instanceId) || null;
    resolvedTarget = { role: target.role, graveyardCard: gyCard };
  }

  if (actionType === "skill" && source.dbId === "L-11") {
    const drunk = getActiveEffects(room, source, "damage_reduction").some(e => e.id?.startsWith("l11_drunk"));
    if (drunk) return { ok:false, reason:"blocked" };
  }

  if (targetCard && targetCard.owner !== role && target.pos.line === "back" && !canTargetBackRow(room, source, target.role) && !(source.dbId === "L-11" && actionType === "skill")) {
    return { ok:false, reason:"front_block" };
  }

  source.pa -= cost;

  if (isSupportAction(source, actionType)) {
    const supportRes = executeSupportAction(room, actionType, source, resolvedTarget || target);
    if (!supportRes.ok) {
      source.pa += cost;
      if (source.turnActionUses && source.turnActionUses[actionType] > 0) {
        source.turnActionUses[actionType] -= 1;
      }
      return supportRes;
    }
    return { ok:true, actionType, support:true, from, role, target: resolvedTarget?.pos ? { role: resolvedTarget.role, pos: resolvedTarget.pos } : null, extra: supportRes };
  }

  const multiplier = actionType === "skill" ? 1.2 : 2.5;
  let rawDmg = getEffectiveAtk(room, source) * multiplier;
  let ignoreDef = false;
  let l15SkillBonus = 1;

  if (actionType === "skill" && source.dbId === "L-15") {
    rawDmg = getEffectiveAtk(room, source);
    l15SkillBonus = 1.15;
  }

  if (actionType === "skill") {
    if (source.effectType === "buff_self_atk") addStatusEffect(source, { id:`skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:30, turnsLeft:1, filters:{}, meta:{} });
    if (source.effectType === "lifesteal") addStatusEffect(source, { id:`skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:20, turnsLeft:1, filters:{}, meta:{} });
    if (source.effectType === "splash") addStatusEffect(source, { id:`skill_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:10, turnsLeft:1, filters:{}, meta:{} });
    if (source.effectType === "pierce_and_party_heal") ignoreDef = true;
  }
  if (actionType === "ult" && source.effectType === "buff_self_atk") {
    addStatusEffect(source, { id:`ult_atk_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_flat", value:150, turnsLeft:1, filters:{}, meta:{} });
  }
  if (actionType === "ult" && source.dbId === "L-1") {
    addStatusEffect(source, { id:`l1_ult_${source.instanceId}`, sourceDbId: source.dbId, type:"atk_mult", value:2, turnsLeft:1, filters:{}, meta:{} });
  }

  const enemyRole = enemyRoleOf(role);
  if (!resolvedTarget || resolvedTarget.role !== enemyRole) return { ok:false, reason:"need_enemy_target" };

  const targetDef = ignoreDef ? 0 : getEffectiveDef(room, resolvedTarget.card);
  const rawDelta = Math.floor(rawDmg - targetDef);
  let finalDmg = rawDelta > 0 ? rawDelta : 0;
  if (l15SkillBonus !== 1 && finalDmg > 0) finalDmg = Math.floor(finalDmg * l15SkillBonus);

  let deaths = [];
  let dmgToTarget = 0;
  let dmgToAttacker = 0;
  let playerDmgToEnemy = 0;
  let playerDmgToMe = 0;

  if (rawDelta > 0) {
    const damageRes = applyDamageToCard(room, source, resolvedTarget.role, resolvedTarget.pos, finalDmg);
    dmgToTarget = damageRes.dmg || 0;
    deaths = deaths.concat(damageRes.deaths || []);
    if (dmgToTarget > 0) playerDmgToEnemy = applyPlayerDamageFromCardHit(room, resolvedTarget.role, dmgToTarget);
  } else if (rawDelta < 0) {
    const reflect = Math.abs(rawDelta);
    const reflectRes = applyDamageToCard(room, resolvedTarget.card, role, from, reflect, { skipRedirect: true });
    dmgToAttacker = reflectRes.dmg || 0;
    deaths = deaths.concat(reflectRes.deaths || []);
    if (dmgToAttacker > 0) playerDmgToMe = applyPlayerDamageFromCardHit(room, role, dmgToAttacker);
    finalDmg = 0;
  }

  if (actionType === "skill" && source.dbId === "L-5") {
    addStatusEffect(resolvedTarget.card, { id:`l5_mark_${source.instanceId}`, sourceDbId: source.dbId, type:"l5_mark", value:0, turnsLeft:2, filters:{}, meta:{ sourceOwner: source.owner } });
    addStatusEffect(resolvedTarget.card, { id:`l5_vuln_${source.instanceId}`, sourceDbId: source.dbId, type:"damage_taken_mult", value:1.2, turnsLeft:2, filters:{}, meta:{} });
  }

  if (actionType === "skill" && source.dbId === "L-12" && resolvedTarget.card && dmgToTarget > 0) {
    const poison = Math.floor(getEffectiveAtk(room, source) * 0.2);
    addStatusEffect(resolvedTarget.card, { id:`l12_infect_${source.instanceId}_${resolvedTarget.card.instanceId}`, sourceDbId: source.dbId, type:"infection", value:poison, turnsLeft:2, filters:{}, meta:{ sourceInstanceId: source.instanceId } });
  }

  if (actionType === "skill" && source.dbId === "L-15" && resolvedTarget.card) {
    addStatusEffect(resolvedTarget.card, { id:`l15_runa_${resolvedTarget.card.instanceId}`, sourceDbId: source.dbId, type:"l15_runa", value:1.15, turnsLeft:3, filters:{}, meta:{} });
  }

  if (source.dbId === "L-12" && dmgToTarget > 0 && getActiveEffects(room, resolvedTarget.card, "infection").length > 0) {
    const enemyEntity = room.state[resolvedTarget.role];
    const infected = ["front","back"].flatMap(line => enemyEntity[line].filter(card => card && getActiveEffects(room, card, "infection").length > 0));
    const spreadDamage = Math.floor(dmgToTarget * 0.5);
    for (const card of infected) {
      const pos = findCardPosition(room, resolvedTarget.role, card.instanceId);
      if (pos) {
        const res = applyDamageToCard(room, source, resolvedTarget.role, pos, spreadDamage, { isSplash: true, skipReflect: true });
        deaths = deaths.concat(res.deaths || []);
      }
    }
  }

  if (source.dbId === "L-9" && getActiveEffects(room, source, "l9_spill").length > 0 && dmgToTarget > 0) {
    if (resolvedTarget.pos.line === "front") {
      const enemyEntity = room.state[resolvedTarget.role];
      const spillDamage = Math.floor(dmgToTarget * 0.3);
      for (let i=0;i<5;i++){
        const enemy = enemyEntity.back[i];
        if (enemy) {
          const res = applyDamageToCard(room, source, resolvedTarget.role, { line:"back", index:i }, spillDamage, { isSplash: true, skipReflect: true });
          deaths = deaths.concat(res.deaths || []);
        }
      }
    }
  }

  if (source.dbId === "L-9" && actionType === "ult" && dmgToTarget > 0) {
    const enemyEntity = room.state[resolvedTarget.role];
    const splashDmg = Math.floor(dmgToTarget * 0.75);
    for (const line of ["front","back"]){
      for (let i=0;i<5;i++){
        const enemy = enemyEntity[line][i];
        if (enemy) {
          const res = applyDamageToCard(room, source, resolvedTarget.role, { line, index: i }, splashDmg, { isSplash: true, skipReflect: true });
          deaths = deaths.concat(res.deaths || []);
        }
      }
    }
  }

  if (source.dbId === "L-10" && getActiveEffects(room, source, "l10_skill_active").length > 0) {
    addStatusEffect(source, { id:`l10_skill_shield_${source.instanceId}_${Date.now()}`, sourceDbId: source.dbId, type:"shield", value:20, turnsLeft:3, filters:{}, meta:{} });
  }

  if (actionType === "ult" && source.effectType === "lifesteal" && dmgToTarget > 0) {
    const heal = Math.floor(dmgToTarget * 0.5);
    source.hp = Math.min(source.maxHp ?? source.hp, (source.hp ?? 0) + heal);
  }

  if (actionType === "ult" && source.effectType === "splash" && dmgToTarget > 0) {
    const enemyEntity = room.state[resolvedTarget.role];
    const splashDmg = Math.floor(dmgToTarget * 0.5);
    for (const line of ["front","back"]){
      for (let i=0;i<5;i++){
        const enemy = enemyEntity[line][i];
        if (enemy && enemy.instanceId !== resolvedTarget.card.instanceId) {
          const res = applyDamageToCard(room, source, resolvedTarget.role, { line, index: i }, splashDmg, { isSplash: true, skipReflect: true });
          deaths = deaths.concat(res.deaths || []);
        }
      }
    }
  }

  if (actionType === "ult" && source.effectType === "pierce_and_party_heal" && dmgToTarget > 0) {
    const healAmount = Math.floor(dmgToTarget * 0.5);
    const allies = room.state[source.owner];
    for (const ally of ["front","back"].flatMap(line => allies[line].filter(c => c))) {
      ally.hp = Math.min(ally.maxHp ?? ally.hp, (ally.hp ?? 0) + healAmount);
    }
  }

  if (resolvedTarget.card) {
    const l5Marks = getActiveEffects(room, resolvedTarget.card, "l5_mark");
    const hasL5 = l5Marks.some(mark => mark.meta?.sourceOwner === source.owner);
    if (hasL5 && dmgToTarget > 0) {
      const heal = Math.floor(dmgToTarget * 0.2);
      source.hp = Math.min(source.maxHp ?? source.hp, (source.hp ?? 0) + heal);
    }
  }

  if (resolvedTarget.card && dmgToTarget > 0) {
    handlePaSteal(room, source, resolvedTarget.card);
  }

  return {
    ok:true,
    actionType,
    from,
    role,
    target: { role: resolvedTarget.role, pos: resolvedTarget.pos },
    dmg: dmgToTarget,
    dmgToTarget,
    dmgToAttacker,
    playerDmgToEnemy,
    playerDmgToMe,
    deaths
  };
}

function applyHab(room, role, from, target){
  return applyAction(room, role, from, target, "skill");
}

function applyUlt(room, role, from, target){
  return applyAction(room, role, from, target, "ult");
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
  handleControlRelease(room);
  applyStartTurnEffects(room, role);
  const deaths = cleanupDeadCards(room, role);
  decrementStatusEffectsForRole(room, role);

  room.match.activeRole = role;
  room.match.drawnThisTurn[role] = false;

  // compra automática por vez (consome a compra da vez)
  const card = drawOne(room, role);
  room.match.drawnThisTurn[role] = true;

  emitEvent(room, { type: "turnStart", role, round: room.match.round, isGameStart: !!isGameStart });
  if (deaths.length) emitEvent(room, { type: "death", deaths });
  if (card) emitEvent(room, { type: "draw", role });
}

function initGameForRoom(room) {
  room.match = {
    activeRole: "p1",
    round: 1,
    turnCounter: 1,
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
    deckInstances.forEach(card => { card.owner = role; });
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
    if (room.match.winner) return;

    const username = usersByToken.get(String(token || ""));
    if (!username) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.username !== username) return;
    const role = player.role;

    if (!intent || !intent.type) return;

    if (intent.type === "endTurn") {
      if (room.match.activeRole !== role) return;

      gainPAOnBoard(room, role, END_TURN_PA_GAIN);

      const next = role === "p1" ? "p2" : "p1";
      if (role === "p2") {
        room.match.round += 1;
        resetPIForBoth(room);
      }
      room.match.turnCounter += 1;
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

      card.owner = role;
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
      if (target) {
        const tr = target.role === "p1" || target.role === "p2" ? target.role : null;
        if (target.pos && isValidLine(target.pos.line) && isValidIndex(target.pos.index) && tr) {
          t = { role: tr, pos: { line: target.pos.line, index: target.pos.index } };
        } else if (Number.isInteger(target.graveyardIndex) && tr) {
          t = { role: tr, graveyardIndex: target.graveyardIndex };
        } else if (target.instanceId && tr) {
          t = { role: tr, instanceId: target.instanceId };
        }
      }

      const res = applyHab(room, role, { line: from.line, index: from.index }, t);
      if (!res.ok) return;

      emitEvent(room, { type: "hab", ...res });
      emitGameOver(room);
      sendSync(room);
      return;
    }

    
    if (intent.type === "useUlt") {
      if (room.match.activeRole !== role) return;

      const { from, target } = intent;
      if (!from) return;
      if (!isValidLine(from.line) || !isValidIndex(from.index)) return;

      let t = null;
      if (target) {
        const tr = target.role === "p1" || target.role === "p2" ? target.role : null;
        if (target.pos && isValidLine(target.pos.line) && isValidIndex(target.pos.index) && tr) {
          t = { role: tr, pos: { line: target.pos.line, index: target.pos.index } };
        } else if (Number.isInteger(target.graveyardIndex) && tr) {
          t = { role: tr, graveyardIndex: target.graveyardIndex };
        } else if (target.instanceId && tr) {
          t = { role: tr, instanceId: target.instanceId };
        } else if (target.suit) {
          t = { suit: target.suit };
        }
      }

      const res = applyUlt(room, role, { line: from.line, index: from.index }, t);
      if (!res.ok) return;

      emitEvent(room, { type: "ult", ...res });
      if (res.deaths && res.deaths.length) emitEvent(room, { type: "death", deaths: res.deaths });
      emitGameOver(room);
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
      attacker.owner = role;

      const pa = Number.isInteger(attacker.pa) ? attacker.pa : 0;
      if (pa < ATTACK_PA_COST) return;

      if (to.line === "back") {
        if (!canAttackBack(attacker, room, enemy)) return;
      }

      attacker.pa = pa - ATTACK_PA_COST;

      const atk = getEffectiveAtk(room, attacker);
      const def = getEffectiveDef(room, target);
      const raw = atk - def;

      let dmgToTarget = 0;
      let dmgToAttacker = 0;
      let playerDmgToEnemy = 0;
      let playerDmgToMe = 0;
      let deaths = [];

      if (raw > 0) {
        const res = applyDamageToCard(room, attacker, enemy, { line: to.line, index: to.index }, raw);
        dmgToTarget = res.dmg;
        deaths = deaths.concat(res.deaths || []);
        if (dmgToTarget > 0) playerDmgToEnemy = applyPlayerDamageFromCardHit(room, enemy, dmgToTarget);
      } else if (raw < 0) {
        const reflect = Math.abs(raw);
        const res = applyDamageToCard(room, target, role, { line: from.line, index: from.index }, reflect, { skipRedirect: true });
        dmgToAttacker = res.dmg;
        deaths = deaths.concat(res.deaths || []);
        if (dmgToAttacker > 0) playerDmgToMe = applyPlayerDamageFromCardHit(room, role, dmgToAttacker);
      }

      if (attacker && (attacker.hp ?? 0) <= 0 && !deaths.find(d => d.card.instanceId === attacker.instanceId)) {
        deaths.push({ role, from: { line: from.line, index: from.index }, card: { ...attacker, hp: 0 } });
        me.graveyard.push({ ...attacker, hp: 0 });
        me[from.line][from.index] = null;
      }

      if (target && (target.hp ?? 0) <= 0 && !deaths.find(d => d.card.instanceId === target.instanceId)) {
        deaths.push({ role: enemy, from: { line: to.line, index: to.index }, card: { ...target, hp: 0 } });
        opp.graveyard.push({ ...target, hp: 0 });
        opp[to.line][to.index] = null;
      }

      if (dmgToTarget > 0) {
        handlePaSteal(room, attacker, target);
      }

      if (attacker.dbId === "L-10" && getActiveEffects(room, attacker, "l10_skill_active").length > 0) {
        addStatusEffect(attacker, { id:`l10_skill_shield_${attacker.instanceId}_${Date.now()}`, sourceDbId: attacker.dbId, type:"shield", value:20, turnsLeft:3, filters:{}, meta:{} });
      }

      if (attacker.dbId === "L-12" && dmgToTarget > 0 && getActiveEffects(room, target, "infection").length > 0) {
        const infected = ["front","back"].flatMap(line => opp[line].filter(card => card && getActiveEffects(room, card, "infection").length > 0));
        const spreadDamage = Math.floor(dmgToTarget * 0.5);
        for (const card of infected) {
          const pos = findCardPosition(room, enemy, card.instanceId);
          if (pos) {
            const res = applyDamageToCard(room, attacker, enemy, pos, spreadDamage, { isSplash: true, skipReflect: true });
            deaths = deaths.concat(res.deaths || []);
          }
        }
      }

      if (attacker.dbId === "L-9" && getActiveEffects(room, attacker, "l9_spill").length > 0 && dmgToTarget > 0 && to.line === "front") {
        const spillDamage = Math.floor(dmgToTarget * 0.3);
        for (let i=0;i<5;i++){
          const enemyCard = opp.back[i];
          if (enemyCard) {
            const res = applyDamageToCard(room, attacker, enemy, { line:"back", index: i }, spillDamage, { isSplash: true, skipReflect: true });
            deaths = deaths.concat(res.deaths || []);
          }
        }
      }

      if (target && dmgToTarget > 0) {
        const l5Marks = getActiveEffects(room, target, "l5_mark");
        const hasL5 = l5Marks.some(mark => mark.meta?.sourceOwner === role);
        if (hasL5) {
          const heal = Math.floor(dmgToTarget * 0.2);
          attacker.hp = Math.min(attacker.maxHp ?? attacker.hp, (attacker.hp ?? 0) + heal);
        }
      }

      emitEvent(room, { type: "attack", role, from: { line: from.line, index: from.index }, to: { line: to.line, index: to.index }, dmgToTarget, dmgToAttacker, playerDmgToEnemy, playerDmgToMe });
      if (deaths.length) emitEvent(room, { type: "death", deaths });
      emitGameOver(room);

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
