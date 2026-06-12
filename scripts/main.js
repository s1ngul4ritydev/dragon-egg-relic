// ============================================================
// DragonEggRelic — Behavior Pack
// Compatível com Minecraft Bedrock 26.1.2 (engine 1.26.x)
// @minecraft/server stable 2.x — SEM experimentos beta necessários
//
// MECÂNICAS:
//   1. Portador do Ovo do Dragão recebe Strength II e +5 corações.
//   2. Ao perder o ovo, os buffs são removidos.
//   3. Na morte, o ovo cai normalmente no chão.
//   4. Partículas do End (tipo Enderman) flutuam ao redor do portador.
// ============================================================

import { world, system } from "@minecraft/server";

// ── Configurações centrais ───────────────────────────────────
const CONFIG = Object.freeze({
  ITEM_ID: "minecraft:dragon_egg",

  // Strength II (amplifier 0 = I, 1 = II)
  STRENGTH_AMPLIFIER: 1,

  // Duração dos efeitos em ticks (30 s). Renovado a cada CHECK_INTERVAL,
  // portanto nunca expira enquanto o jogador tiver o ovo.
  EFFECT_DURATION: 600,

  // Vida máxima base do jogador em HP (1 coração = 2 HP)
  //   Padrão:    20 HP  (10 corações)
  //   Com o ovo: 30 HP  (15 corações = +5 corações extras)
  HEALTH_DEFAULT:  20,
  HEALTH_WITH_EGG: 30,

  // Intervalo de verificação do inventário (ticks)
  CHECK_INTERVAL: 20, // 1 segundo — equilibro entre responsividade e performance

  // Cooldown da mensagem de bloqueio de drop (ticks)
  ACTIONBAR_COOLDOWN: 100, // 5 segundos entre mensagens

  // Partícula do End que flutua ao redor do portador
  // ID vanilla Bedrock — efeito roxo/violeta igual ao dos Endermans
  // Alternativas: "minecraft:portal_directional", "minecraft:portal_east_west"
  PARTICLE_ID: "minecraft:enderman_teleport",

  // Quantas partículas spawnar por ciclo (cada CHECK_INTERVAL ticks)
  PARTICLE_COUNT: 5,

  // Raio horizontal (blocos) em que as partículas aparecem ao redor do jogador
  PARTICLE_RADIUS: 0.9,
});

// ── Estado em memória ────────────────────────────────────────

/** IDs dos jogadores que atualmente possuem o Ovo do Dragão. */
const playersWithEgg = new Set();

/**
 * IDs de jogadores que morreram recentemente.
 * Usado para distinguir drops de morte (permitidos) de drops manuais (bloqueados).
 */
const dyingPlayers = new Set();

/** Último tick em que cada jogador recebeu a mensagem de bloqueio. */
const actionbarCooldowns = new Map();

// ── Funções auxiliares ───────────────────────────────────────

/**
 * Retorna true se o jogador tiver minecraft:dragon_egg em qualquer slot do inventário.
 * Verifica todos os 36 slots (hotbar 0–8 + inventário principal 9–35).
 */
function playerHasDragonEgg(player) {
  const inv = player.getComponent("minecraft:inventory");
  if (!inv?.container) return false;
  const container = inv.container;
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (item?.typeId === CONFIG.ITEM_ID) return true;
  }
  return false;
}

/**
 * Aplica Strength II e aumenta a vida máxima para 30 HP (+5 corações).
 *
 * Correção para a vida máxima:
 *   Primário  → attribute command (stable no Bedrock 26.1.2).
 *   Fallback  → efeito health_boost caso o comando não esteja disponível.
 */
function applyBuffs(player) {
  try {
    // Strength II — sem partículas
    player.addEffect("strength", CONFIG.EFFECT_DURATION, {
      amplifier: CONFIG.STRENGTH_AMPLIFIER,
      showParticles: false,
    });

    // +5 corações extras: define vida máxima base para 30 HP
    try {
      player.runCommand(`attribute @s minecraft:health base set ${CONFIG.HEALTH_WITH_EGG}`);
    } catch (_) {
      // Fallback: health_boost (amplifier 1 ≈ +4 corações, mais próximo disponível via efeito)
      player.addEffect("health_boost", CONFIG.EFFECT_DURATION, {
        amplifier: 1,
        showParticles: false,
      });
    }
  } catch (_) {
    // Jogador em estado inválido (ex.: ainda carregando); ignorar silenciosamente.
  }
}

/**
 * Remove Strength II, restaura a vida máxima para 20 HP
 * e ajusta a vida atual caso ultrapasse o novo máximo.
 */
function removeBuffs(player) {
  try {
    player.removeEffect("strength");

    // Restaurar vida máxima base para 20 HP
    try {
      player.runCommand(`attribute @s minecraft:health base set ${CONFIG.HEALTH_DEFAULT}`);
    } catch (_) {
      player.removeEffect("health_boost");
    }

    // Se a vida atual ultrapassar o novo máximo, ajustar no próximo tick
    system.run(() => {
      try {
        const healthComp = player.getComponent("minecraft:health");
        if (healthComp && healthComp.currentValue > healthComp.effectiveMax) {
          healthComp.setCurrentValue(healthComp.effectiveMax);
        }
      } catch (_) {}
    });
  } catch (_) {
    // Ignorar silenciosamente.
  }
}

/**
 * Spawna partículas do End ao redor do jogador, distribuídas em círculo.
 * Usa dimension.spawnParticle() que é stable no @minecraft/server 2.x.
 *
 * Cada partícula aparece em uma posição aleatória dentro de um cilindro
 * de raio PARTICLE_RADIUS e altura do corpo do jogador (0 – 2.5 blocos),
 * replicando o efeito visual dos Endermans.
 */
function spawnEndParticles(player) {
  const loc = player.location;
  const dim = player.dimension;
  const count = CONFIG.PARTICLE_COUNT;
  const radius = CONFIG.PARTICLE_RADIUS;

  for (let i = 0; i < count; i++) {
    // Ângulo uniformemente distribuído em 360° + variação aleatória de offset
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const r = radius * (0.5 + Math.random() * 0.5); // raio entre 50% e 100% do máximo

    try {
      dim.spawnParticle(CONFIG.PARTICLE_ID, {
        x: loc.x + Math.cos(angle) * r,
        y: loc.y + Math.random() * 2.5 + 0.1, // altura aleatória ao longo do corpo
        z: loc.z + Math.sin(angle) * r,
      });
    } catch (_) {
      // Ignorar se a dimensão/localização for inválida neste tick
    }
  }
}

/**
 * Exibe uma mensagem na actionbar do jogador, respeitando o cooldown.
 * A chamada de onScreenDisplay é adiada para fora do contexto de evento.
 */
function showActionBar(player, message) {
  const now = system.currentTick;
  const lastShown = actionbarCooldowns.get(player.id) ?? -(CONFIG.ACTIONBAR_COOLDOWN + 1);
  if (now - lastShown < CONFIG.ACTIONBAR_COOLDOWN) return;

  actionbarCooldowns.set(player.id, now);
  system.run(() => {
    try {
      player.onScreenDisplay.setActionBar(message);
    } catch (_) {}
  });
}

// ── Loop principal: verificação de inventário ────────────────
//
// Roda a cada CHECK_INTERVAL ticks (1 s).
// Complexidade: O(jogadores × 36 slots) — negligenciável até centenas de jogadores.
//
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const hasEgg = playerHasDragonEgg(player);
    const hadEgg = playersWithEgg.has(player.id);

    if (hasEgg) {
      if (!hadEgg) {
        // Jogador acabou de pegar o ovo → registrar e aplicar buffs
        playersWithEgg.add(player.id);
      }
      // Renovar efeitos para que nunca expirem enquanto o ovo estiver no inventário
      applyBuffs(player);
      // Partículas do End flutuando ao redor do portador a cada ciclo
      spawnEndParticles(player);
    } else if (hadEgg) {
      // Jogador perdeu o ovo → remover buffs e parar rastreamento
      playersWithEgg.delete(player.id);
      removeBuffs(player);
    }
  }
}, CONFIG.CHECK_INTERVAL);

// ── Bloqueio de drop manual ──────────────────────────────────
//
// IMPORTANTE: world.beforeEvents.itemDrop não está no stable 2.x do @minecraft/server.
// Workaround estável: escutar world.afterEvents.entitySpawn para detectar quando
// o Ovo do Dragão aparece como entidade no mundo e devolvê-lo ao jogador imediatamente.
//
// Drops de MORTE são permitidos: dyingPlayers filtra esses casos.
//
world.afterEvents.entitySpawn.subscribe((event) => {
  const entity = event.entity;

  // Apenas entidades do tipo item
  if (entity.typeId !== "minecraft:item") return;

  // Verificar se é o Ovo do Dragão
  const itemComp = entity.getComponent("item");
  if (!itemComp?.itemStack || itemComp.itemStack.typeId !== CONFIG.ITEM_ID) return;

  // Procurar o jogador mais próximo (até 5 blocos) que estava rastreando o ovo
  // e NÃO morreu recentemente.
  let targetPlayer = null;
  let minDist = Infinity;

  try {
    const candidates = entity.dimension.getPlayers({
      location: entity.location,
      maxDistance: 5,
    });

    for (const player of candidates) {
      // Ignorar: jogador não rastreado ou acabou de morrer (drop de morte é intencional)
      if (!playersWithEgg.has(player.id)) continue;
      if (dyingPlayers.has(player.id)) continue;

      const loc = entity.location;
      const pLoc = player.location;
      const dist = Math.sqrt(
        (loc.x - pLoc.x) ** 2 +
        (loc.y - pLoc.y) ** 2 +
        (loc.z - pLoc.z) ** 2
      );
      if (dist < minDist) {
        minDist = dist;
        targetPlayer = player;
      }
    }
  } catch (_) {}

  if (!targetPlayer) return; // Não é um drop manual de um portador → ignorar

  // Remover a entidade do ovo do mundo
  try {
    entity.kill();
  } catch (_) {
    try { entity.remove(); } catch (_) {}
  }

  // Devolver o ovo ao inventário do jogador e exibir aviso
  system.run(() => {
    try {
      targetPlayer.runCommand("give @s minecraft:dragon_egg 1");
    } catch (_) {}
    showActionBar(targetPlayer, "§6✦ §eVocê não pode dropar a Relíquia do Dragão! §6✦");
  });
});

// ── Evento de morte do jogador ───────────────────────────────
//
// Ao morrer com o ovo:
//   1. Remove o jogador do rastreamento de buffs.
//   2. Marca como "morrendo" para que o entitySpawn ignore o drop natural.
//   3. Os efeitos são removidos automaticamente pelo jogo na morte.
//   4. O ovo cai no chão normalmente para outro jogador pegar.
//
world.afterEvents.entityDie.subscribe((event) => {
  const entity = event.deadEntity;
  if (entity.typeId !== "minecraft:player") return;

  const playerId = entity.id;

  // Remover do rastreamento (buffs já foram retirados pela morte)
  playersWithEgg.delete(playerId);

  // Sinalizar morte para liberar o drop do ovo no mundo
  dyingPlayers.add(playerId);

  // Limpar o estado de "morrendo" após 3 segundos (tempo suficiente para
  // todos os itens spawnarem como entidades de mundo).
  system.runTimeout(() => {
    dyingPlayers.delete(playerId);
  }, 60); // 60 ticks = 3 segundos
});
