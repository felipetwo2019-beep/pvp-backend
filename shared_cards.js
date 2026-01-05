/* shared_cards.js
   UMD module so it works in both Browser (window.SharedCards) and Node (require()).
*/
(function(root, factory){
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SharedCards = factory();
  }
})(typeof self !== "undefined" ? self : this, function(){
  function normRarity(r){
    const x = String(r || "").toLowerCase();
    if (x === "legendary" || x === "lendario" || x === "lendária") return "LEGENDARY";
    if (x === "epic" || x === "epico" || x === "épico") return "EPIC";
    if (x === "rare" || x === "raro") return "RARE";
    if (x === "common" || x === "comum") return "COMMON";
    if (x === "utility" || x === "utilitaria" || x === "utilitária") return "UTILITY";
    return "COMMON";
  }
  function normType(t){
    const x = String(t || "").toLowerCase();
    if (x === "melee") return "Melee";
    if (x === "tank") return "Tank";
    if (x === "ranged") return "Ranged";
    if (x === "support" || x === "suporte") return "Support";
    if (x === "utility") return "Utility";
    return "Melee";
  }

  // Card model DB extracted from your single-player registerCard() list
  // IMPORTANT: dbId must be unique per model.
  const CARD_DB = {
    "L-1": { dbId:"L-1", type:normType("Melee"), rarity:normRarity("legendary"), name:"G. da Espada", tribe:"Guerreiro", atk:100, def:30, maxHp:400, enterPA:5, piCost:5, habName:"Bênção da Espada", habDesc:'HAB: Essa carta e todas as cartas do tipo "Guerreiro" ganham 50 de ATK por 3 turnos', ultName:"Fúria do Campeão", ultDesc:"Essa carta ganha +100% ATK por 1 turno", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/x1Y59x6v/G-Guerreiro.png" },
    "L-2": { dbId:"L-2", type:normType("Ranged"), rarity:normRarity("legendary"), name:"G. do Arco", tribe:"Arqueiro", atk:85, def:20, maxHp:300, enterPA:5, piCost:5, habName:"Olho de Águia", habDesc:"+20% Crítico (2 turnos) em Ranged/Suporte aliados", ultName:"Chuva Perfeita", ultDesc:"100% Crítico (1 turno) em todos aliados", effectType:"pierce_and_party_heal", img:"https://i.postimg.cc/pVzKyQh1/G-ARCO.png" },
    "L-3": { dbId:"L-3", type:normType("Tank"), rarity:normRarity("legendary"), name:"G. do Sangue", tribe:"Berserks", atk:50, def:40, maxHp:500, enterPA:5, piCost:5, habName:"Sangue em Fúria", habDesc:"+10 ATK por 30 HP perdidos (4 turnos)", ultName:"Pacto de Interceptação", ultDesc:"Intercepta dano de uma carta aliada por (2 turnos)", effectType:"pierce_and_party_heal", img:"https://i.postimg.cc/RV11p1vx/G-Berserk.png" },
    "L-4": { dbId:"L-4", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. da Cura", tribe:"Curandeiros", atk:60, def:15, maxHp:350, enterPA:5, piCost:5, habName:"Cântico Revigorante", habDesc:"+2 PA agora e no próximo turno (todos aliados) por 2 turnos", ultName:"Milagre de Etheria", ultDesc:"Cura full todos os aliados em campo", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/nzsY36Lh/G-CURA.png" },
    "L-5": { dbId:"L-5", type:normType("Melee"), rarity:normRarity("legendary"), name:"G. das Bestas", tribe:"Bestiais", atk:90, def:25, maxHp:480, enterPA:5, piCost:5, habName:"Marca da Alcateia", habDesc:"HAB: Após usar a habilidade no alvo ele será marcado e sofrerá 20% a mais da dano e todas as cartas aliadas que atacar recuperam 20% de hp do dano causado por 2 turnos", ultName:"Fúria Bestial", ultDesc:"Essa carta sacrifica 25% da vida e toda sua defesa para aumentar seu poder de ataque em 75% por 2 turno", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/CMqskTtD/G-BESTIAIS.png" },
    "L-6": { dbId:"L-6", type:normType("Tank"), rarity:normRarity("legendary"), name:"G. do Escudo", tribe:"Protetores", atk:50, def:45, maxHp:600, enterPA:5, piCost:5, habName:"Muralha Protetora", habDesc:"HAB: Reduz em 10% o dano sofrido por todas as cartas aliadas em campo", ultName:"Égide Imortal", ultDesc:"A ultimate dessa carta deixa invulnerável qualquer carta aliada, pode ser usada em si mesmo.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/XvYgCZSG/G-Escudo.png" },
    "L-7": { dbId:"L-7", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. do Ouro", tribe:"Herdeiros", atk:60, def:20, maxHp:400, enterPA:5, piCost:5, habName:"Tributo Dourado", habDesc:"HAB: Para cada carta na mão do jogador e do seu oponente essa carta aumenta em 10 o poder de ATK da carta aliada, pode ser usado em si mesmo.)", ultName:"Decreto da Paz", ultDesc:"Se o alvo for aliado cura 100% da vida e o deixa pacifista, se for inimigo deixa ele em estado pacifista e ele não poderá causar dano por 1 turno", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/YSMQ151S/G-Ouro.png" },
    "L-8": { dbId:"L-8", type:normType("Melee"), rarity:normRarity("legendary"), name:"G. da Morte", tribe:"Esqueletos", atk:95, def:15, maxHp:400, enterPA:5, piCost:5, habName:"Ecos do Ossário", habDesc:'HAB: +20 de ATK para cada carta do tipo "Esqueleto" no cemiério e no campo de batalha, além disso 20% do dano sofrido por essa carta é redistribuido para os Esqueletos em campo por 2 turnos', ultName:"Ceifa do Além", ultDesc:'Essa carta ganha todo o poder de ataque somado de todas as cartas do tipo "Esqueletos" no cemitério por 1 turno.', effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/9XKTxRG6/G-Morte.png" },
    "L-9": { dbId:"L-9", type:normType("Melee"), rarity:normRarity("legendary"), name:"G. da Lança", tribe:"Lanceiros", atk:80, def:30, maxHp:400, enterPA:5, piCost:5, habName:"Postura da Falange", habDesc:"HAB: +20 ATK por Lanceiro aliado em campo (2 turnos). Ao causar dano em alvo da linha de frente, aplica 30% do dano causado na backline inimiga.", ultName:"Lança Implacável", ultDesc:"ULT: 75% do dano no alvo é aplicado a todos inimigos.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/5t4sS7vV/G-Lanca.png" },
    "L-10": { dbId:"L-10", type:normType("Tank"), rarity:normRarity("legendary"), name:"G. da Máscara", tribe:"Anônimos", atk:55, def:35, maxHp:500, enterPA:5, piCost:5, habName:"Véu da Máscara", habDesc:"HAB: -20% dano recebido, +10% dano causado e +2% por 20 de sobrevida (3 turnos). Ganha +20 sobrevida por ataque.", ultName:"Golpe Oculto", ultDesc:"ULT: Concede sobrevida (20% HP máx) a todos aliados por 2 turnos.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/vBDghbDY/G-mascara.png" },
    "L-11": { dbId:"L-11", type:normType("Tank"), rarity:normRarity("legendary"), name:"G. do Álcool", tribe:"Pandistas", atk:55, def:45, maxHp:550, enterPA:5, piCost:5, habName:"Troca de Posição", habDesc:"HAB: Troca a posição (frente ↔ trás) de uma carta aliada ou inimiga. Custa 1 PA e pode ser usada 2x no turno.", ultName:"Estado Bêbado", ultDesc:"ULT: Usa em si mesma para alternar entre BÊBADO (-25% dano recebido) e SÓBRIO (+25% ATK). Permanece até alternar novamente.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/sgDWnt6d/G-Alcool.png" },
    "L-12": { dbId:"L-12", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. da Árvore", tribe:"Silvestres", atk:50, def:15, maxHp:400, enterPA:5, piCost:5, habName:"Brinde Bélico", habDesc:"HAB: Infecta alvo por 2 turnos (veneno = 20% do ATK da L-12). Ao atacar infectado, todas cartas infectadas sofrem 50% do dano.", ultName:"Rugido do Barril", ultDesc:"ULT: Infecta todos inimigos e cura aliados em 20% do HP máx. Um aliado ganha +20 ATK por curado (2 turnos).", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/SKRWKwCm/G-ARVORE.png" },
    "L-13": { dbId:"L-13", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. das Criaturas", tribe:"Invocadores", atk:60, def:20, maxHp:400, enterPA:5, piCost:5, habName:"Seiva Vital", habDesc:"HAB: Invoca do cemitério (Comum/Rara/Épica) para seu campo. Máx 2 invocações controladas.", ultName:"Raízes Ancestrais", ultDesc:"ULT: Controle mental por 1 turno completo; pode mover ao seu campo e usar habilidade/ultimate. Não pode controlar a mesma carta novamente.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/xCqgWXth/G-invocador.png" },
    "L-14": { dbId:"L-14", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. da Tecnologia", tribe:"Tecmagos", atk:60, def:25, maxHp:400, enterPA:5, piCost:5, habName:"Engrenagem Arcana", habDesc:"HAB: Dobra efeitos utilitários aliados por 2 turnos e dá +2 PA agora +2 PA no próximo turno ao alvo.", ultName:"Núcleo Supremo", ultDesc:"ULT (6 PA): Suspende buffs/debuffs temporários inimigos por 1 turno, aplica +25% dano recebido por 2 turnos e concede sobrevida 10% aos aliados.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/zG9fnKKy/G-Tecnologia.png" },
    "L-15": { dbId:"L-15", type:normType("Ranged"), rarity:normRarity("legendary"), name:"G. da Magia", tribe:"Magos", atk:80, def:15, maxHp:400, enterPA:5, piCost:5, habName:"Runa", habDesc:"HAB (3 PA): Causa dano base de ataque +15% e marca o alvo com Runa (+15% dano recebido) por 3 turnos completos.", ultName:"Explodir Runas", ultDesc:"ULT: Drena DEF e rouba ATK de inimigos marcados com Runa. Escala com a quantidade de marcas.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/T1Dy80Vv/G-mago.png" },
    "L-16": { dbId:"L-16", type:normType("Melee"), rarity:normRarity("legendary"), name:"G. da Sorte", tribe:"Trevos", atk:80, def:30, maxHp:450, enterPA:5, piCost:5, habName:"Sorte do Trevo", habDesc:"HAB: Rola 1d6 em um aliado. Chance de converter dano em cura + bônus de ATK por 1 turno completo.", ultName:"Destino Favorável", ultDesc:"ULT: Escolha um naipe (Espadas/Copas/Ouro/Paus) e aplique seu efeito por 1 turno completo.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/bJLDHdzX/G-SORTE.png" },
    "L-17": { dbId:"L-17", type:normType("Ranged"), rarity:normRarity("legendary"), name:"G. da Pólvora", tribe:"Bandidos", atk:75, def:20, maxHp:400, enterPA:5, piCost:5, habName:"Compra Rápida", habDesc:"HAB: Ativa modo de compra. Clique no deck para comprar 1 carta.", ultName:"Forçar Compra", ultDesc:"ULT: Oponente compra 1 carta e você rouba 2 cartas da mão dele.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/v8N7pSdS/G-Polvora.png" },
    "L-18": { dbId:"L-18", type:normType("Ranged"), rarity:normRarity("legendary"), name:"G. dos Portais", tribe:"Vagantes", atk:85, def:20, maxHp:480, enterPA:5, piCost:5, habName:"Comando de Vanguarda", habDesc:"HAB: Buff global +20% ATK por 2 turnos; alvo recebe +2 PA agora e +2 PA no próximo turno; Melee/Tank podem atacar a linha de trás por 2 turnos.", ultName:"Triplo Deslocamento", ultDesc:"ULT: Envie 1 inimigo do campo ao topo do deck, 1 carta da mão inimiga ao fundo do deck, e 1 carta do cemitério inimigo ao seu cemitério.", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/QxS9WfXq/G-PORTAL.png" },
    "L-19": { dbId:"L-19", type:normType("Suporte"), rarity:normRarity("legendary"), name:"G. do Tempo", tribe:"Cronomantes", atk:60, def:25, maxHp:450, enterPA:5, piCost:5, habName:"Ritmo Temporal", habDesc:"Self: +1 PA para aliados agora; no próximo turno +2 PA e 10% de roubar 1 PA ao causar dano.", ultName:"Paradoxo do Tempo", ultDesc:"Self: próximo ataque rouba 1 PA. Time: 40% de roubar 1 PA ao causar dano (1 turno).", effectType:"temporal_rhythm", img:"https://i.postimg.cc/VkSqf9z1/G-TEMPO.png" },

    "E-1": { dbId:"E-1", type:normType("Suporte"), rarity:normRarity("epic"), name:"Carta Épica", tribe:"Cronomantes", atk:60, def:25, maxHp:450, enterPA:4, piCost:4, habName:"Eco Cronomântico", habDesc:"Cura Front Row (50% Dano)", ultName:"Salto Temporal", ultDesc:"Buff: +150 ATK", effectType:"heal_front_on_back_hit", img:"https://i.postimg.cc/8CgPgdtJ/A18-TEMPO.png" },

    "R-1": { dbId:"R-1", type:normType("Ranged"), rarity:normRarity("rare"), name:"Arqueiro Mestre", tribe:"Arqueiros", atk:70, def:20, maxHp:300, enterPA:3, piCost:3, habName:"Tiro Preciso", habDesc:"Buff: +20 ATK", ultName:"Disparo Vampírico", ultDesc:"Cura 50% Dano", effectType:"lifesteal", img:"https://robohash.org/R-1?set=set2&size=300x300" },

    "C-1": { dbId:"C-1", type:normType("Melee"), rarity:normRarity("common"), name:"Esqueleto Comum", tribe:"Esqueletos", atk:40, def:20, maxHp:100, enterPA:2, piCost:2, habName:"Ossos Afiados", habDesc:"Buff: +10 ATK", ultName:"Explosão Óssea", ultDesc:"Dano em Área", effectType:"splash", img:"https://robohash.org/C-1?set=set2&size=300x300" },

    // Utility
    "U-1": { dbId:"U-1", type:normType("Utility"), rarity:normRarity("utility"), name:"Poção de Energia", tribe:"Item", atk:0, def:0, maxHp:0, enterPA:0, piCost:1, habName:"Infusão Energética", habDesc:"+3 PA ao alvo", ultName:null, ultDesc:"-", effectType:"add_pa", img:"https://robohash.org/U-1?set=set3&size=300x300" },
  };

  for (const id in CARD_DB) {
    const card = CARD_DB[id];
    card.habDesc = "";
    card.ultDesc = "";
    card.effectType = null;
  }

  // Ensure maxHp sane
  for (const id in CARD_DB) {
    const c = CARD_DB[id];
    const hp = Number.isFinite(c.maxHp) ? c.maxHp : 0;
    if (!Number.isFinite(c.maxHp) || c.maxHp < 0) c.maxHp = 0;
    if (c.maxHp < 0) c.maxHp = 0;
  }

  const ALL_CARDS = Object.values(CARD_DB);

  const DeckRules = {
    MIN: 5,
    MAX: 50,
    rarityCaps: { LEGENDARY: 3, EPIC: 5, RARE: 10, COMMON: Infinity, UTILITY: Infinity },
    dupCaps: { LEGENDARY: 1, EPIC: 1, RARE: 2, COMMON: 3, UTILITY: 3 },
  };

  function validateDeck(deckDbIds){
    const errors = [];
    const deck = Array.isArray(deckDbIds) ? deckDbIds.slice() : [];
    if (deck.length < DeckRules.MIN) errors.push(`Deck precisa ter no mínimo ${DeckRules.MIN} cartas.`);
    if (deck.length > DeckRules.MAX) errors.push(`Deck pode ter no máximo ${DeckRules.MAX} cartas.`);

    const countsById = {};
    const rarityCounts = { LEGENDARY:0, EPIC:0, RARE:0, COMMON:0, UTILITY:0 };

    for (const id of deck) {
      const model = CARD_DB[id];
      if (!model) {
        errors.push(`Carta inválida no deck: ${id}`);
        continue;
      }
      countsById[id] = (countsById[id] || 0) + 1;
      rarityCounts[model.rarity] = (rarityCounts[model.rarity] || 0) + 1;
    }

    for (const rar of Object.keys(DeckRules.rarityCaps)) {
      const cap = DeckRules.rarityCaps[rar];
      if (Number.isFinite(cap) && rarityCounts[rar] > cap) {
        errors.push(`Limite de ${rar} excedido: ${rarityCounts[rar]}/${cap}`);
      }
    }

    for (const id of Object.keys(countsById)) {
      const model = CARD_DB[id];
      const cap = DeckRules.dupCaps[model.rarity] ?? 1;
      if (countsById[id] > cap) {
        errors.push(`Carta ${id} (${model.name}) excede limite de cópias: ${countsById[id]}/${cap}`);
      }
    }

    return { ok: errors.length === 0, errors, rarityCounts, countsById };
  }

  function shuffleInPlace(arr){
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function instantiateCard(dbId, ownerRole){
    const m = CARD_DB[dbId];
    if (!m) return null;
    return {
      instanceId: `${ownerRole}-${dbId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      dbId: m.dbId,
      name: m.name,
      tribe: m.tribe,
      type: m.type,
      rarity: m.rarity,
      stars: m.piCost,
      piCost: m.piCost,
      atk: m.atk,
      def: m.def,
      hp: m.maxHp,
      maxHp: m.maxHp,
      pa: m.enterPA,
      maxPa: 11,
      habName: m.habName,
      habDesc: m.habDesc,
      ultName: m.ultName,
      ultDesc: m.ultDesc,
      ultReadyRound: 1,
      effectType: m.effectType,
      img: m.img,
    };
  }

  return { CARD_DB, ALL_CARDS, DeckRules, validateDeck, shuffleInPlace, instantiateCard, normRarity, normType };
});
