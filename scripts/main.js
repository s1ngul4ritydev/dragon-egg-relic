// ============================================================
// DragonEggRelic — scripts/main.js
// Target: Minecraft Bedrock 26.20 + @minecraft/server 2.6.0 stable
//
// Main protection model:
// - The first player that legitimately owns the Dragon Egg becomes the
//   persistent relic holder.
// - The relic is forced to stay in the holder inventory.
// - Manual drops, placed blocks, item frames/entities, Ender Chest,
//   chests, hoppers, minecarts, chest boats, shulkers, barrels, etc.
//   are blocked or cleaned.
// - Duplicate/creative eggs on other players are warned for 5 seconds,
//   then deleted.
// ============================================================

import { world, system, ItemStack } from "@minecraft/server";

const CONFIG = Object.freeze({
  ITEM_ID: "minecraft:dragon_egg",

  HOLDER_ID_KEY: "dragon_egg_relic:holder_id",
  HOLDER_NAME_KEY: "dragon_egg_relic:holder_name",

  CHECK_INTERVAL: 20,
  DELETION_WARNING_TICKS: 100,
  ACTIONBAR_INTERVAL: 20,

  STRENGTH_AMPLIFIER: 1,
  EFFECT_DURATION: 80,

  // IMPORTANT:
  // Bedrock stable Script API cannot directly set a player's max health to
  // exactly 30 HP from main.js only. Health Boost works in jumps.
  // Existing amplifier 1 usually gives +4 hearts; amplifier 2 is the next
  // stronger fallback. For exact +5 red hearts, use player.json component
  // groups and set USE_PLAYER_JSON_HEALTH_EVENTS to true.
  HEALTH_BOOST_FALLBACK_AMPLIFIER: 2,

  USE_PLAYER_JSON_HEALTH_EVENTS: true,
  ENABLE_HEALTH_EVENT: "dragon_egg_relic:enable_health",
  DISABLE_HEALTH_EVENT: "dragon_egg_relic:disable_health",

  PARTICLE_IDS: [
    "minecraft:basic_portal_particle",
    "minecraft:dragon_breath_trail",
  ],
  PARTICLE_COUNT: 10,
  PARTICLE_RADIUS: 0.85,

  NEARBY_CONTAINER_SCAN_EVERY_TICKS: 100,
  NEARBY_CONTAINER_SCAN_HORIZONTAL_RADIUS: 5,
  NEARBY_CONTAINER_SCAN_VERTICAL_RADIUS: 3,
  NEARBY_ENTITY_SCAN_RADIUS: 32,
  NEARBY_ITEM_SCAN_RADIUS: 64,
});

const CONTAINER_BLOCK_IDS = new Set([
  "minecraft:barrel",
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:hopper",
  "minecraft:dropper",
  "minecraft:dispenser",
  "minecraft:furnace",
  "minecraft:blast_furnace",
  "minecraft:smoker",
  "minecraft:brewing_stand",
  "minecraft:ender_chest",
  "minecraft:decorated_pot",
]);

const ITEM_FRAME_TYPES = new Set([
  "minecraft:item_frame",
  "minecraft:glow_item_frame",
]);

const playersWithBuffs = new Set();
const pendingIllegalDeletion = new Map();
const lastActionBarTick = new Map();
const playerJsonHealthEventCache = new Map();

function currentTick() {
  return system.currentTick ?? 0;
}

function isDragonEgg(itemStack) {
  return itemStack?.typeId === CONFIG.ITEM_ID;
}

function safeActionBar(player, message, force = false) {
  const now = currentTick();
  const last = lastActionBarTick.get(player.id) ?? -999999;

  if (!force && now - last < CONFIG.ACTIONBAR_INTERVAL) return;
  lastActionBarTick.set(player.id, now);

  system.run(() => {
    try {
      player.onScreenDisplay.setActionBar(message);
    } catch (_) {}
  });
}

function getWorldString(key) {
  try {
    const value = world.getDynamicProperty(key);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch (_) {
    return undefined;
  }
}

function setWorldString(key, value) {
  try {
    if (value === undefined || value === null || value === "") {
      world.setDynamicProperty(key, undefined);
    } else {
      world.setDynamicProperty(key, String(value));
    }
  } catch (_) {}
}

function getHolderId() {
  return getWorldString(CONFIG.HOLDER_ID_KEY);
}

function getHolderName() {
  return getWorldString(CONFIG.HOLDER_NAME_KEY);
}

function setHolder(player) {
  setWorldString(CONFIG.HOLDER_ID_KEY, player.id);
  setWorldString(CONFIG.HOLDER_NAME_KEY, player.name);
}

function findOnlineHolder() {
  const holderId = getHolderId();
  if (!holderId) return undefined;

  for (const player of world.getAllPlayers()) {
    if (player.id === holderId) return player;
  }

  return undefined;
}

function getInventoryContainer(entity) {
  try {
    return entity.getComponent("minecraft:inventory")?.container;
  } catch (_) {
    return undefined;
  }
}

function getEnderContainer(player) {
  try {
    return player.getComponent("minecraft:ender_inventory")?.container;
  } catch (_) {
    return undefined;
  }
}

function countDragonEggsInContainer(container) {
  if (!container) return 0;

  let count = 0;
  try {
    for (let slot = 0; slot < container.size; slot++) {
      const item = container.getItem(slot);
      if (isDragonEgg(item)) count += Math.max(1, item.amount ?? 1);
    }
  } catch (_) {}

  return count;
}

function removeDragonEggsFromContainer(container, keepOne = false) {
  if (!container) return 0;

  let removed = 0;
  let kept = false;

  try {
    for (let slot = 0; slot < container.size; slot++) {
      const item = container.getItem(slot);
      if (!isDragonEgg(item)) continue;

      const amount = Math.max(1, item.amount ?? 1);

      if (keepOne && !kept) {
        kept = true;

        if (amount > 1) {
          const single = item;
          single.amount = 1;
          container.setItem(slot, single);
          removed += amount - 1;
        }

        continue;
      }

      container.setItem(slot, undefined);
      removed += amount;
    }
  } catch (_) {}

  return removed;
}

function countDragonEggsOnPlayer(player) {
  return (
    countDragonEggsInContainer(getInventoryContainer(player)) +
    countDragonEggsInContainer(getEnderContainer(player))
  );
}

function removeAllDragonEggsFromPlayer(player) {
  const mainRemoved = removeDragonEggsFromContainer(getInventoryContainer(player), false);
  const enderRemoved = removeDragonEggsFromContainer(getEnderContainer(player), false);
  return mainRemoved + enderRemoved;
}

function normalizeHolderInventory(player) {
  const main = getInventoryContainer(player);
  const ender = getEnderContainer(player);

  const mainCountBefore = countDragonEggsInContainer(main);
  const enderCountBefore = countDragonEggsInContainer(ender);

  if (enderCountBefore > 0) {
    removeDragonEggsFromContainer(ender, false);
    safeActionBar(
      player,
      "§cThe Dragon Egg Relic cannot be stored in containers or Ender Chests.",
      true
    );
  }

  if (mainCountBefore <= 0) {
    giveDragonEgg(player);
    return;
  }

  const removed = removeDragonEggsFromContainer(main, true);
  if (removed > 0) {
    safeActionBar(player, "§cDuplicate Dragon Egg removed from your inventory.", true);
  }
}

function giveDragonEgg(player) {
  system.run(() => {
    try {
      const container = getInventoryContainer(player);
      if (container) {
        const leftover = container.addItem(new ItemStack(CONFIG.ITEM_ID, 1));
        if (!leftover) return;
      }
    } catch (_) {}

    try {
      player.runCommand(`give @s ${CONFIG.ITEM_ID} 1`);
    } catch (_) {}
  });
}

function applyRelicEffects(player) {
  try {
    player.addEffect("strength", CONFIG.EFFECT_DURATION, {
      amplifier: CONFIG.STRENGTH_AMPLIFIER,
      showParticles: false,
    });
  } catch (_) {}

  if (CONFIG.USE_PLAYER_JSON_HEALTH_EVENTS) {
    const cached = playerJsonHealthEventCache.get(player.id);
    if (cached !== false) {
      try {
        player.triggerEvent(CONFIG.ENABLE_HEALTH_EVENT);
        playerJsonHealthEventCache.set(player.id, true);
      } catch (_) {
        playerJsonHealthEventCache.set(player.id, false);
      }
    }
  }

  if (!CONFIG.USE_PLAYER_JSON_HEALTH_EVENTS || playerJsonHealthEventCache.get(player.id) === false) {
    try {
      player.addEffect("health_boost", CONFIG.EFFECT_DURATION, {
        amplifier: CONFIG.HEALTH_BOOST_FALLBACK_AMPLIFIER,
        showParticles: false,
      });
    } catch (_) {}
  }

  playersWithBuffs.add(player.id);
}

function removeRelicEffects(player) {
  try {
    player.removeEffect("strength");
  } catch (_) {}

  try {
    player.removeEffect("health_boost");
  } catch (_) {}

  if (CONFIG.USE_PLAYER_JSON_HEALTH_EVENTS) {
    try {
      player.triggerEvent(CONFIG.DISABLE_HEALTH_EVENT);
    } catch (_) {}
  }

  playersWithBuffs.delete(player.id);
}

function spawnEndParticles(player) {
  const loc = player.location;
  const dim = player.dimension;

  for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = CONFIG.PARTICLE_RADIUS * (0.35 + Math.random() * 0.65);
    const particleId = CONFIG.PARTICLE_IDS[i % CONFIG.PARTICLE_IDS.length];

    try {
      dim.spawnParticle(particleId, {
        x: loc.x + Math.cos(angle) * radius,
        y: loc.y + 0.15 + Math.random() * 2.05,
        z: loc.z + Math.sin(angle) * radius,
      });
    } catch (_) {}
  }
}

function scheduleIllegalPlayerDeletion(player) {
  const now = currentTick();

  if (!pendingIllegalDeletion.has(player.id)) {
    pendingIllegalDeletion.set(player.id, now + CONFIG.DELETION_WARNING_TICKS);
  }

  const deleteAt = pendingIllegalDeletion.get(player.id);
  const secondsLeft = Math.max(0, Math.ceil((deleteAt - now) / 20));

  if (secondsLeft > 0) {
    safeActionBar(
      player,
      `§cIllegal Dragon Egg detected. It will be deleted in ${secondsLeft}s for cheat/duplicate use.`,
      true
    );
    return;
  }

  const removed = removeAllDragonEggsFromPlayer(player);
  pendingIllegalDeletion.delete(player.id);

  if (removed > 0) {
    safeActionBar(player, "§cIllegal Dragon Egg deleted for cheat/duplicate use.", true);
  }
}

function cancelIllegalPendingIfClean(player) {
  if (countDragonEggsOnPlayer(player) <= 0) {
    pendingIllegalDeletion.delete(player.id);
  }
}

function getItemEntityStack(entity) {
  try {
    return entity.getComponent("minecraft:item")?.itemStack;
  } catch (_) {
    return undefined;
  }
}

function removeEntity(entity) {
  try {
    entity.kill();
    return;
  } catch (_) {}

  try {
    entity.remove();
  } catch (_) {}
}

function deleteDroppedDragonEggsNearPlayer(player) {
  try {
    const entities = player.dimension.getEntities({
      type: "minecraft:item",
      location: player.location,
      maxDistance: CONFIG.NEARBY_ITEM_SCAN_RADIUS,
    });

    for (const entity of entities) {
      if (isDragonEgg(getItemEntityStack(entity))) {
        removeEntity(entity);
      }
    }
  } catch (_) {}
}

function isContainerBlock(block) {
  if (!block) return false;

  try {
    if (CONTAINER_BLOCK_IDS.has(block.typeId)) return true;
    if (block.typeId.endsWith("_shulker_box")) return true;
    if (block.getComponent("minecraft:inventory")?.container) return true;
  } catch (_) {}

  return false;
}

function sanitizeBlockContainer(block, sourcePlayer = undefined) {
  if (!block) return 0;

  try {
    const container = block.getComponent("minecraft:inventory")?.container;
    const removed = removeDragonEggsFromContainer(container, false);

    if (removed > 0 && sourcePlayer) {
      safeActionBar(
        sourcePlayer,
        "§cThe Dragon Egg Relic cannot be stored in containers.",
        true
      );
    }

    return removed;
  } catch (_) {
    return 0;
  }
}

function sanitizeEntityContainer(entity, sourcePlayer = undefined) {
  if (!entity || entity.typeId === "minecraft:player") return 0;

  try {
    const container = entity.getComponent("minecraft:inventory")?.container;
    const removed = removeDragonEggsFromContainer(container, false);

    if (removed > 0 && sourcePlayer) {
      safeActionBar(
        sourcePlayer,
        "§cThe Dragon Egg Relic cannot be stored in entity containers.",
        true
      );
    }

    return removed;
  } catch (_) {
    return 0;
  }
}

function scanNearbyContainers(player) {
  const dim = player.dimension;
  const base = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };

  const hr = CONFIG.NEARBY_CONTAINER_SCAN_HORIZONTAL_RADIUS;
  const vr = CONFIG.NEARBY_CONTAINER_SCAN_VERTICAL_RADIUS;

  for (let x = base.x - hr; x <= base.x + hr; x++) {
    for (let y = base.y - vr; y <= base.y + vr; y++) {
      for (let z = base.z - hr; z <= base.z + hr; z++) {
        try {
          const block = dim.getBlock({ x, y, z });
          if (block && isContainerBlock(block)) sanitizeBlockContainer(block);
        } catch (_) {}
      }
    }
  }

  try {
    const entities = dim.getEntities({
      location: player.location,
      maxDistance: CONFIG.NEARBY_ENTITY_SCAN_RADIUS,
    });

    for (const entity of entities) {
      sanitizeEntityContainer(entity);
    }
  } catch (_) {}
}

function assignInitialHolderIfNeeded() {
  if (getHolderId()) return;

  for (const player of world.getAllPlayers()) {
    if (countDragonEggsOnPlayer(player) > 0) {
      setHolder(player);
      normalizeHolderInventory(player);
      safeActionBar(
        player,
        `§5✦ §dCurrent Relic Holder: §f${player.name} §5✦`,
        true
      );
      return;
    }
  }
}

function enforceRelicState() {
  assignInitialHolderIfNeeded();

  const holderId = getHolderId();
  const holderName = getHolderName();

  for (const player of world.getAllPlayers()) {
    const isHolder = holderId && player.id === holderId;
    const eggCount = countDragonEggsOnPlayer(player);

    if (isHolder) {
      pendingIllegalDeletion.delete(player.id);
      normalizeHolderInventory(player);
      applyRelicEffects(player);
      spawnEndParticles(player);
      safeActionBar(
        player,
        `§5✦ §dCurrent Relic Holder: §f${player.name} §5✦`
      );
      continue;
    }

    if (eggCount > 0) {
      removeRelicEffects(player);
      scheduleIllegalPlayerDeletion(player);
      continue;
    }

    cancelIllegalPendingIfClean(player);

    if (playersWithBuffs.has(player.id)) {
      removeRelicEffects(player);
    }

    if (holderName && !holderId) {
      safeActionBar(player, `§5✦ §dCurrent Relic Holder: §f${holderName} §5✦`);
    }
  }

  const onlineHolder = findOnlineHolder();
  if (onlineHolder) {
    deleteDroppedDragonEggsNearPlayer(onlineHolder);
  } else {
    for (const player of world.getAllPlayers()) {
      deleteDroppedDragonEggsNearPlayer(player);
    }
  }
}

function handleBlockedRelicAction(player, message = "§cThe Dragon Egg Relic cannot be dropped, placed, framed, or stored.") {
  safeActionBar(player, message, true);
  system.run(() => {
    const holderId = getHolderId();
    if (holderId && player.id === holderId) normalizeHolderInventory(player);
  });
}

function setupEventHandlers() {
  try {
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
      if (!isDragonEgg(event.itemStack)) return;

      if (isContainerBlock(event.block)) {
        event.cancel = true;
        system.run(() => {
          handleBlockedRelicAction(
            event.player,
            "§cThe Dragon Egg Relic cannot be placed in containers."
          );
        });
      }
    });
  } catch (_) {}

  try {
    world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
      if (!isDragonEgg(event.itemStack)) return;

      const target = event.target;
      let targetHasInventory = false;

      try {
        targetHasInventory = Boolean(target.getComponent("minecraft:inventory")?.container);
      } catch (_) {}

      if (ITEM_FRAME_TYPES.has(target.typeId) || targetHasInventory) {
        event.cancel = true;
        system.run(() => {
          handleBlockedRelicAction(
            event.player,
            "§cThe Dragon Egg Relic cannot be placed in item frames or entity containers."
          );
        });
      }
    });
  } catch (_) {}

  try {
    world.beforeEvents.playerPlaceBlock.subscribe((event) => {
      const typeId = event.permutationToPlace?.type?.id;
      if (typeId !== CONFIG.ITEM_ID) return;

      event.cancel = true;
      system.run(() => {
        handleBlockedRelicAction(event.player, "§cThe Dragon Egg Relic cannot be placed as a block.");
      });
    });
  } catch (_) {}

  try {
    world.afterEvents.playerPlaceBlock.subscribe((event) => {
      try {
        if (event.block?.typeId !== CONFIG.ITEM_ID) return;

        event.block.setType("minecraft:air");
        handleBlockedRelicAction(event.player, "§cThe Dragon Egg Relic cannot be placed as a block.");
      } catch (_) {}
    });
  } catch (_) {}

  try {
    world.afterEvents.entityItemDrop.subscribe((event) => {
      const source = event.entity;
      const isPlayerDrop = source?.typeId === "minecraft:player";

      for (const itemEntity of event.items ?? []) {
        if (!isDragonEgg(getItemEntityStack(itemEntity))) continue;

        removeEntity(itemEntity);

        if (!isPlayerDrop) continue;

        const player = source;
        const holderId = getHolderId();

        if (!holderId) {
          setHolder(player);
        }

        if (player.id === getHolderId()) {
          normalizeHolderInventory(player);
          handleBlockedRelicAction(player, "§cThe Dragon Egg Relic cannot be dropped.");
        } else {
          scheduleIllegalPlayerDeletion(player);
        }
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.entitySpawn.subscribe((event) => {
      const entity = event.entity;
      if (entity?.typeId !== "minecraft:item") return;
      if (!isDragonEgg(getItemEntityStack(entity))) return;

      const holderId = getHolderId();

      if (holderId) {
        removeEntity(entity);
        const holder = findOnlineHolder();
        if (holder) normalizeHolderInventory(holder);
      }
    });
  } catch (_) {}

  try {
    world.beforeEvents.entityItemPickup.subscribe((event) => {
      if (!isDragonEgg(getItemEntityStack(event.item))) return;
      if (event.entity?.typeId !== "minecraft:player") return;

      const player = event.entity;
      const holderId = getHolderId();

      if (!holderId) return;

      if (player.id !== holderId || countDragonEggsOnPlayer(player) > 0) {
        event.cancel = true;
        system.run(() => {
          removeEntity(event.item);

          if (player.id === holderId) {
            normalizeHolderInventory(player);
            safeActionBar(player, "§cDuplicate Dragon Egg item deleted.", true);
          } else {
            scheduleIllegalPlayerDeletion(player);
          }
        });
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.blockContainerClosed.subscribe((event) => {
      const source = event.closeSource?.entity;
      const sourcePlayer = source?.typeId === "minecraft:player" ? source : undefined;
      sanitizeBlockContainer(event.block, sourcePlayer);

      if (sourcePlayer) {
        const holderId = getHolderId();
        if (sourcePlayer.id === holderId) normalizeHolderInventory(sourcePlayer);
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.entityContainerClosed.subscribe((event) => {
      const source = event.closeSource?.entity;
      const sourcePlayer = source?.typeId === "minecraft:player" ? source : undefined;
      sanitizeEntityContainer(event.entity, sourcePlayer);

      if (sourcePlayer) {
        const holderId = getHolderId();
        if (sourcePlayer.id === holderId) normalizeHolderInventory(sourcePlayer);
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.playerInventoryItemChange.subscribe((event) => {
      const player = event.player;
      const holderId = getHolderId();

      if (!holderId && isDragonEgg(event.itemStack)) {
        system.run(() => setHolder(player));
        return;
      }

      if (holderId && player.id !== holderId && isDragonEgg(event.itemStack)) {
        system.run(() => scheduleIllegalPlayerDeletion(player));
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.entityDie.subscribe((event) => {
      const dead = event.deadEntity;
      if (dead?.typeId !== "minecraft:player") return;

      const holderId = getHolderId();
      if (dead.id !== holderId) return;

      // The relic is not transferable by death in this locked-holder version.
      // Any dropped egg entity is removed by entitySpawn/entityItemDrop scanning.
      playersWithBuffs.delete(dead.id);
    });
  } catch (_) {}

  try {
    world.afterEvents.playerSpawn.subscribe((event) => {
      const player = event.player;
      const holderId = getHolderId();

      if (holderId && player.id === holderId) {
        system.runTimeout(() => {
          normalizeHolderInventory(player);
          applyRelicEffects(player);
        }, 5);
      }
    });
  } catch (_) {}

  try {
    world.afterEvents.playerLeave.subscribe((event) => {
      pendingIllegalDeletion.delete(event.playerId);
      playersWithBuffs.delete(event.playerId);
      lastActionBarTick.delete(event.playerId);
      playerJsonHealthEventCache.delete(event.playerId);
    });
  } catch (_) {}
}

setupEventHandlers();

system.runInterval(() => {
  enforceRelicState();

  if (currentTick() % CONFIG.NEARBY_CONTAINER_SCAN_EVERY_TICKS === 0) {
    for (const player of world.getAllPlayers()) {
      scanNearbyContainers(player);
    }
  }
}, CONFIG.CHECK_INTERVAL);
