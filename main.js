/**
 * eat stuff — Game Logic
 * 
 * A canvas-based "eat to grow" game. Player moves around a map,
 * eats quantum foam to grow, and must eat the adversary to win.
 * Features: upgrade tree, options menu, localStorage save/load.
 */

const CONFIG = {
    baseWidth: 800,
    baseHeight: 600,
    visualScale: 10,
    mapSize: 2000,
    baseLevelTimeLimit: 20,
    deathDelayFrames: 60,
    victoryDelayFrames: 60,
    summaryInputLockFrames: 30,
    growthScale: 0.2,
    baseGrowthScale: 0.2,
    baseSpeed: 2.8,
    speedMultiplier: 1.05,
    adversarySpeedMultiplier: 2,
    particleCountPerFoam: 8,
    deathParticleCount: 30
};

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const buttonsEl = document.getElementById('buttons');

let width, height;
let uiScale = 1;

function resize() {
    const oldWidth = width;
    const oldHeight = height;
    const dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    uiScale = Math.min(width / CONFIG.baseWidth, height / CONFIG.baseHeight);

    // The map is centred in screen space; keep the world aligned with it.
    if (oldWidth !== undefined && oldHeight !== undefined) {
        shiftWorld((width - oldWidth) / 2, (height - oldHeight) / 2);
    }
}
window.addEventListener('resize', resize);
resize();

function scale(px) {
    return px * uiScale;
}

const INPUT = {
    keys: {},
    activeKeys: 0,
    mouse: { sx: 0, sy: 0, down: false }
};

window.addEventListener('keydown', e => {
    if (!INPUT.keys[e.code]) INPUT.activeKeys++;
    INPUT.keys[e.code] = true;
});
window.addEventListener('keyup', e => {
    if (INPUT.keys[e.code]) INPUT.activeKeys--;
    INPUT.keys[e.code] = false;
});
window.addEventListener('blur', () => {
    // Otherwise a key held while alt-tabbing stays "down" forever.
    INPUT.keys = {};
    INPUT.activeKeys = 0;
    INPUT.mouse.down = false;
    treeDragging = false;
    treeDragStartPos = null;
    // Don't let the player die while the window is unfocused.
    if (state === 'playing') {
        previousState = 'playing';
        state = 'pause';
    }
});

let MAP_SIZE = CONFIG.mapSize;

const player = {
    x: width / 2,
    y: height / 2,
    size: 1,
    targetSize: 1,
    color: '#888888',
    speed: CONFIG.baseSpeed,
    angle: 0,
    targetAngle: 0
};

const playerImg = new Image();
playerImg.src = 'assets/player.png';

const qFoamImg = new Image();
qFoamImg.src = 'assets/qfoam.png';

const neutrinoImg = new Image();
neutrinoImg.src = 'assets/neutrino.png';

const topQuarkImg = new Image();
topQuarkImg.src = 'assets/topquark.png';

const bottomQuarkImg = new Image();
bottomQuarkImg.src = 'assets/bottomquark.png';

let cameraX = player.x;
let cameraY = player.y;
let currentZoom = 4.0;
let targetZoom = currentZoom;

let treeX = 0;
let treeY = 0;
let treeZoom = 1;
let treeDragging = false;
let treeDragStart = { x: 0, y: 0, treeX: 0, treeY: 0 };
let treeDragStartPos = null; // screen position at mousedown, for click detection

// ── Game State ───────────────────────────────────────────────

let currentLevel = null;
let foam = [];
let particles = [];
let refinedMatter = 0;
let keys = 0;
let completedLevels = [];
let state = 'title';
let previousState = 'title';
let optionsReturnState = 'title';
let selectedSlot = 1;
let deleteConfirmSlot = null;
let crtBloom = false;
let levelTimer = 0;
let adversary = null;
let adversarySpawnHint = null;
let bigNeutrinosSpawned = false;
let arrowTarget = null;
let arrowOpacity = 0;
let arrowPending = null;
let arrowFadingOut = false;
let lastEaten = null;
const adversaryImg = new Image();
adversaryImg.src = 'assets/adversary.png';

const sadversaryImg = new Image();
sadversaryImg.src = 'assets/sadversary.png';

// The PNGs are 400x400 with a lot of transparent padding, and each sprite's
// visible body fills a different fraction of the image. Crop to the opaque
// content so one unit of `size` is the same number of pixels for every entity.
const SPRITE_BOUNDS = {
    player:     { x: 63,  y: 63,  w: 274, h: 274 },
    qfoam:      { x: 104, y: 95,  w: 192, h: 192 },
    neutrino:   { x: 43,  y: 43,  w: 314, h: 314 },
    topquark:   { x: 66,  y: 66,  w: 268, h: 268 },
    bottomquark: { x: 66,  y: 66,  w: 268, h: 268 },
    adversary:  { x: 98,  y: 98,  w: 204, h: 204 }
};
const SPRITE_RADIUS_SCALE = 0.6;

/**
 * Draws a sprite cropped to its visible content.
 * @returns {boolean} False if the image is not ready (caller can draw a fallback).
 */
function drawSprite(img, bounds, x, y, radius, rotation = 0) {
    if (!img.complete || img.naturalWidth === 0 || !bounds) return false;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(
        img,
        bounds.x, bounds.y, bounds.w, bounds.h,
        -radius, -radius, radius * 2, radius * 2
    );
    ctx.restore();
    return true;
}

/**
 * Sprite-space radius for a world-position lookup.
 */
function entityRadius(size) {
    return Math.max(size * getLevelVisualScale() * SPRITE_RADIUS_SCALE, 3);
}

let deathParticles = [];
let summaryStats = null;
let deathDelay = 0;
let summaryInputLock = 0;
let victoryDelay = 0;

/**
 * Moves every world-space entity with the map when the window is resized.
 */
function shiftWorld(dx, dy) {
    if (!dx && !dy) return;
    player.x += dx;
    player.y += dy;
    cameraX += dx;
    cameraY += dy;
    for (const f of foam) { f.x += dx; f.y += dy; }
    for (const p of particles) { p.x += dx; p.y += dy; }
    for (const p of deathParticles) { p.x += dx; p.y += dy; }
    if (adversary) {
        adversary.x += dx;
        adversary.y += dy;
    }
}

// ── Level & Upgrade Data ─────────────────────────────────────

const levels = [
    {
        id: 1,
        name: 'Level 1',
        foamCount: 150,
        startingSize: 1,
        startZoom: 2.5,
        visualScale: 10,
        timeLimit: 20,
        zoomThresholds: [],
        objective: { type: 'size', target: 10, unit: 'Planck Lengths' }
    },
    {
        id: 2,
        name: 'Level 2',
        startingSize: 1,
        startZoom: 4.0,
        startOffsetX: 600,
        visualScale: 3.0,
        timeLimit: 60,
        mapSize: 8000,
        mapSize: 4000,
        zoomThresholds: [
            { size: 5, zoom: 2.5, barrierRadius: 700 },
            { size: 20, zoom: 1.5, barrierRadius: 950 },
            { size: 100, zoom: 0.2, barrierRadius: 3500 }
        ],
        objective: { type: 'size', target: 350, unit: 'yoctometres' },
          food: [
              { kind: 'top', size: 1, count: 250, dangerous: false },
              { kind: 'neutrino', size: [1, 30], count: 250, dangerous: false, weight: [3, 1] }
          ],
        centerFood: { kind: 'bottom', size: 300, dangerous: false }
    }
];

const FOOD_INFO = {
    foam: {
        name: 'Quantum Foam',
        color: '#2a2ac2',
        img: qFoamImg,
        bounds: SPRITE_BOUNDS.qfoam
    },
    top: {
        name: 'Top Quark',
        color: '#9e2e2e',
        img: topQuarkImg,
        bounds: SPRITE_BOUNDS.topquark
    },
    neutrino: {
        name: 'Neutrino',
        color: '#fff21d',
        img: neutrinoImg,
        bounds: SPRITE_BOUNDS.neutrino
    },
    bottom: {
        name: 'Bottom Quark',
        color: '#c28d3d',
        img: bottomQuarkImg,
        bounds: SPRITE_BOUNDS.bottomquark
    },
    adversary: {
        name: 'Adversary',
        color: '#ff0000',
        img: adversaryImg,
        bounds: SPRITE_BOUNDS.adversary
    }
};

function getCurrentLevelData() {
    return levels.find(l => l.id === currentLevel) || null;
}

function isLevelUnlocked(levelId) {
    const idx = levels.findIndex(l => l.id === levelId);
    if (idx <= 0) return true;
    const prevId = levels[idx - 1].id;
    return completedLevels.includes(prevId);
}

function getLevelVisualScale() {
    return getCurrentLevelData()?.visualScale ?? CONFIG.visualScale;
}

function getSizeUnit() {
    return getCurrentLevelData()?.objective?.unit ?? 'Planck Lengths';
}

function getLevelTimeLimit() {
    const base = getCurrentLevelData()?.timeLimit ?? CONFIG.baseLevelTimeLimit;
    const timerLevel = upgradeNodes.find(n => n.id === 'timer')?.level ?? 0;
    return base + timerLevel;
}

/**
 * Returns the half-extents of the next unbroken rectangular barrier, or null
 * when all barriers for the level have disappeared.
 */
function getActiveBarrier() {
    const lvl = getCurrentLevelData();
    if (!lvl || !lvl.zoomThresholds) return null;
    const next = lvl.zoomThresholds.find(t => {
        if (!(player.size < t.size)) return false;
        const hw = Number.isFinite(t.barrierHalfW) ? t.barrierHalfW : t.barrierRadius;
        const hh = Number.isFinite(t.barrierHalfH) ? t.barrierHalfH : t.barrierRadius;
        return Number.isFinite(hw) && Number.isFinite(hh);
    });
    if (!next) return null;
    const hw = Number.isFinite(next.barrierHalfW) ? next.barrierHalfW : next.barrierRadius;
    const hh = Number.isFinite(next.barrierHalfH) ? next.barrierHalfH : next.barrierRadius;
    return { halfW: hw, halfH: hh };
}

const upgradeNodes = [
    { id: 'speed', name: 'Speed I', level: 0, maxLevel: 3, baseCost: 5, x: 0, y: 0, w: 80, h: 80, description: 'Increase movement speed by 5% per level.' },
    { id: 'growth', name: 'Growth I ', level: 0, maxLevel: 5, baseCost: 5, x: -120, y: 0, w: 80, h: 80, requires: 'speed', description: 'Increase growth scaling by 0.01 per level.' },
    { id: 'timer', name: 'Timer I', level: 0, maxLevel: 5, baseCost: 5, x: 120, y: 0, w: 80, h: 80, requires: 'speed', description: 'Increase the timer for each level by 1s per level.' },
    { id: 'keyUpgrade', name: 'The Arrow', level: 0, maxLevel: 1, baseCost: 1, costType: 'key', x: 0, y: -120, w: 80, h: 80, requires: 'speed', description: 'Unlocks the arrow. (beat a level to get a key!)' },
    { id: 'dummy', name: 'Better Arrow', level: 0, maxLevel: 5, baseCost: 5, x: 0, y: -240, w: 80, h: 80, requires: 'keyUpgrade', description: 'Increase the arrow detection radius (it can point to objects further away)' }
];

// ── Entity Spawning ──────────────────────────────────────────

/**
 * Spawns an edible entity at a random position within the map.
 * @param {number} [size] - Size of the entity in the current level's units.
 * @param {string} [kind] - Food kind, used for its sprite and label.
 * @param {number} [x] - Optional fixed X position.
 * @param {number} [y] - Optional fixed Y position.
 * @param {boolean} [dangerous] - Whether touching it before outgrowing it kills the player.
 * @returns {object} An edible entity with position, size, and shake properties.
 */
function spawnFoam(size = 1, kind = 'foam', x = null, y = null, dangerous = false) {
    const inset = Math.max(0, MAP_SIZE / 2 - entityRadius(size));
    const info = FOOD_INFO[kind] || FOOD_INFO.foam;
    return {
        x: Number.isFinite(x) ? x : width / 2 + (Math.random() * 2 - 1) * inset,
        y: Number.isFinite(y) ? y : height / 2 + (Math.random() * 2 - 1) * inset,
        size: size,
        kind: kind,
        dangerous: dangerous === true,
        color: info.color,
        shakeX: 0,
        shakeY: 0,
        shakeTimer: 0,
        shakeOffsetX: Math.random() * 1000,
        shakeOffsetY: Math.random() * 1000
    };
}

/**
 * Spawns burst particles at a given position.
 * @param {number} x - X coordinate to spawn at.
 * @param {number} y - Y coordinate to spawn at.
 * @param {number} count - Number of particles to spawn.
 * @param {string} color - Particle fill color.
 */
function spawnParticles(x, y, count, color) {
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x,
            y: y,
            vx: (Math.random() - 0.5) * 6,
            vy: (Math.random() - 0.5) * 6,
            life: 1.0,
            color: color,
            size: 2 + Math.random() * 3
        });
    }
}

/**
 * Applies level zoom thresholds when the player reaches certain sizes.
 * Lowers the target camera zoom at predetermined size thresholds per level.
 */
function applyZoomThresholds() {
    const lvl = getCurrentLevelData();
    if (!lvl || !lvl.zoomThresholds) return;
    for (const t of lvl.zoomThresholds) {
        if (player.size >= t.size) {
            targetZoom = Math.min(targetZoom, t.zoom);
        }
    }
}

// ── Game State Transitions ───────────────────────────────────

/**
 * Starts a level by resetting game state and spawning foam entities.
 * @param {number} levelId - The ID of the level to start.
 * @param {number} [slot] - Save slot to associate with this play session.
 */
function startLevel(levelId, slot) {
    if (slot !== undefined) selectedSlot = slot;
    const lvl = levels.find(l => l.id === levelId);
    if (!lvl) return;
    currentLevel = levelId;
    state = 'playing';
    MAP_SIZE = lvl.mapSize ?? CONFIG.mapSize;
    currentZoom = lvl.startZoom ?? 2.5;
    targetZoom = currentZoom;
    levelTimer = 0;
    adversary = null;
    adversarySpawnHint = null;
    bigNeutrinosSpawned = false;
    lastEaten = null;
    deathParticles = [];
    deathDelay = 0;
    summaryInputLock = 0;
    victoryDelay = 0;
    summaryStats = null;
    foam = [];
    particles = [];

    const startSize = lvl.startingSize ?? 1;
    player.x = width / 2 + (lvl.startOffsetX ?? 0);
    player.y = height / 2 + (lvl.startOffsetY ?? 0);
    player.size = startSize;
    player.targetSize = startSize;
    player.angle = 0;
    player.targetAngle = 0;
    cameraX = player.x;
    cameraY = player.y;

    if (lvl.food) {
        for (const spec of lvl.food) {
            for (let i = 0; i < spec.count; i++) {
                let entity = null;
                let specSize = Array.isArray(spec.size) ? (spec.size[0] + Math.random() * (spec.size[1] - spec.size[0])) : spec.size;
                if (spec.kind === 'neutrino' && Array.isArray(spec.size)) {
                    const w = Array.isArray(spec.weight) ? spec.weight : [1, 1];
                    const r = Math.random() * (w[0] + w[1]);
                    if (r > w[0]) {
                        specSize = (spec.size[1] + spec.size[0]) * 0.5 + Math.random() * (spec.size[1] - (spec.size[1] + spec.size[0]) * 0.5);
                        const candidate = spawnFoam(specSize, spec.kind, null, null, spec.dangerous);
                        const angle = Math.random() * Math.PI * 2;
                        const dist = 1500 + Math.random() * 3500;
                        candidate.x = width / 2 + Math.cos(angle) * dist;
                        candidate.y = height / 2 + Math.sin(angle) * dist;
                        if (lvl.centerFood) {
                            const cfRadius = entityRadius(lvl.centerFood.size);
                            const eRadius = entityRadius(specSize);
                            const dx = candidate.x - width / 2;
                            const dy = candidate.y - height / 2;
                            if (Math.sqrt(dx * dx + dy * dy) < cfRadius + eRadius + 4) {
                                // skip
                            } else {
                                foam.push(candidate);
                                continue;
                            }
                        } else {
                            foam.push(candidate);
                            continue;
                        }
                    } else {
                        specSize = spec.size[0] + Math.random() * 3;
                    }
                }
                for (let attempt = 0; attempt < 50; attempt++) {
                    const candidate = spawnFoam(specSize, spec.kind, null, null, spec.dangerous);
                    if (lvl.centerFood) {
                        const cfRadius = entityRadius(lvl.centerFood.size);
                        const eRadius = entityRadius(specSize);
                        const dx = candidate.x - width / 2;
                        const dy = candidate.y - height / 2;
                        if (Math.sqrt(dx * dx + dy * dy) < cfRadius + eRadius + 4) {
                            continue;
                        }
                    }
                    entity = candidate;
                    break;
                }
                if (entity) foam.push(entity);
            }
        }
    } else {
        for (let i = 0; i < (lvl.foamCount ?? 0); i++) {
            foam.push(spawnFoam());
        }
    }
    if (lvl.centerFood) {
        foam.push(spawnFoam(
            lvl.centerFood.size,
            lvl.centerFood.kind,
            width / 2,
            height / 2,
            lvl.centerFood.dangerous
        ));
    }

    applyZoomThresholds();
    setButtons([]);
}

/**
 * Transitions to the upgrade tree screen, resetting tree pan/zoom.
 */
function goToUpgrade() {
    state = 'upgrade';
    treeX = 0;
    treeY = 0;
    treeZoom = 1;
}

/**
 * Returns to the level select screen.
 */
function returnToLevelSelect() {
    state = 'level_select';
}

/**
 * Restarts the current level.
 */
function retryLevel() {
    if (currentLevel) {
        startLevel(currentLevel);
    }
}

/**
 * Ends the active run from the pause menu and opens the run summary.
 */
function endCurrentRun() {
    if (state !== 'pause' || previousState !== 'playing') return;
    summaryStats = {
        refinedMatter: refinedMatter,
        size: player.size,
        time: Math.max(0, Math.floor(levelTimer)),
        ended: true
    };
    summaryInputLock = CONFIG.summaryInputLockFrames;
    state = 'summary';
    INPUT.mouse.down = false;
    INPUT.keys['Enter'] = false;
    saveGame(selectedSlot);
}

/**
 * Applies an upgrade to a node if the player can afford it.
 * @param {string} nodeId - The ID of the upgrade node to purchase.
 */
function applyUpgrade(nodeId) {
    const n = upgradeNodes.find(u => u.id === nodeId);
    if (!n) return;
    // Check prerequisite
    if (n.requires) {
        const req = upgradeNodes.find(u => u.id === n.requires);
        if (!req || req.level < 1) return;
    }
    const cost = n.baseCost * (n.level + 1);
    const isKeyCost = n.costType === 'key';
    if (isKeyCost) {
        if (keys < cost) return;
    } else {
        if (refinedMatter < cost) return;
    }
    if (n.level >= n.maxLevel) return;
    if (nodeId === 'speed') {
        player.speed += CONFIG.baseSpeed * 0.05;
    }
    if (nodeId === 'growth') {
        CONFIG.growthScale += 0.01;
    }
    n.level += 1;
    if (isKeyCost) {
        keys -= cost;
    } else {
        refinedMatter -= cost;
    }
    saveGame(selectedSlot);
}

// ── Save / Load ──────────────────────────────────────────────

/**
 * Persists game progress to localStorage for a specific save slot.
 * Silently fails if storage is unavailable (private mode, quota exceeded).
 * @param {number} slot - Save slot number (1-3).
 */
function saveGame(slot = 1) {
    try {
        const data = {
            refinedMatter,
            keys,
            completedLevels,
            upgradeNodes: upgradeNodes.map(n => ({ id: n.id, level: n.level })),
            crtBloom
        };
        localStorage.setItem(`eatStuffSave_${slot}`, JSON.stringify(data));
    } catch (e) {
        // storage unavailable; silently skip
    }
}

/**
 * Resets all meta progress to a fresh save state.
 * Called before loading a slot so an empty/corrupt slot cannot inherit
 * upgrades from the slot that was previously selected.
 */
function resetProgress() {
    refinedMatter = 0;
    keys = 0;
    completedLevels = [];
    upgradeNodes.forEach(n => { n.level = 0; });
    player.speed = CONFIG.baseSpeed;
    CONFIG.growthScale = CONFIG.baseGrowthScale;
    crtBloom = false;
}

/**
 * Loads game progress from a specific save slot.
 * Silently ignores corrupt or missing save data.
 * @param {number} slot - Save slot number (1-3).
 */
function loadGame(slot = 1) {
    resetProgress();

    let raw = null;
    try {
        raw = localStorage.getItem(`eatStuffSave_${slot}`);
    } catch (e) {
        // storage unavailable
    }

    if (raw) {
        try {
            const data = JSON.parse(raw);
            if (Number.isFinite(data.refinedMatter) && data.refinedMatter >= 0) {
                refinedMatter = Math.floor(data.refinedMatter);
            }
            if (Number.isFinite(data.keys) && data.keys >= 0) {
                keys = Math.floor(data.keys);
            }
            if (Array.isArray(data.completedLevels)) {
                completedLevels = data.completedLevels.filter(v => Number.isFinite(v));
            }
            if (Array.isArray(data.upgradeNodes)) {
                data.upgradeNodes.forEach(d => {
                    const n = upgradeNodes.find(u => u.id === d.id);
                    if (n && Number.isFinite(d.level)) {
                        n.level = Math.max(0, Math.min(n.maxLevel, Math.floor(d.level)));
                    }
                });
            }
            if (typeof data.crtBloom === 'boolean') crtBloom = data.crtBloom;
        } catch (e) {
            // corrupt save: keep the fresh state from resetProgress()
        }
    }

    // Derive stats from upgrade levels (never from stale multipliers).
    const speedNode = upgradeNodes.find(u => u.id === 'speed');
    player.speed = CONFIG.baseSpeed + CONFIG.baseSpeed * 0.05 * (speedNode?.level ?? 0);

    const growthNode = upgradeNodes.find(u => u.id === 'growth');
    CONFIG.growthScale = CONFIG.baseGrowthScale;
    for (let i = 0; i < (growthNode?.level ?? 0); i++) {
        CONFIG.growthScale += 0.01;
    }

    state = 'title';
}

/**
 * Deletes a save slot from localStorage.
 * Silently fails if storage is unavailable.
 * @param {number} slot - Save slot number (1-3).
 */
function deleteSave(slot) {
    let removed = false;
    try {
        localStorage.removeItem(`eatStuffSave_${slot}`);
        removed = true;
    } catch (e) {
        // storage unavailable; silently skip
    }

    // If deleting the active slot, reset game state so it doesn't retain old data
    if (removed && slot === selectedSlot) {
        resetProgress();
        state = 'title';
    }
}

// ── UI ───────────────────────────────────────────────────────

/**
 * Renders UI buttons based on a list of button specifications.
 * @param {Array<{label: string, onClick: Function}>} specs - Button specifications.
 */
function setButtons(specs) {
    buttonsEl.innerHTML = '';
    if (specs.length === 0) {
        buttonsEl.classList.add('hidden');
        return;
    }
    buttonsEl.classList.remove('hidden');
    specs.forEach(spec => {
        const b = document.createElement('button');
        b.textContent = spec.label;
        b.addEventListener('click', spec.onClick);
        buttonsEl.appendChild(b);
    });
}

// ── Game Loop: Update ────────────────────────────────────────

/**
 * Handles summary screen state transitions (input lock countdown).
 */
function updateSummary() {
    if (summaryInputLock > 0) {
        summaryInputLock -= 1;
    }
}

/**
 * Handles player movement input and position updates.
 */
function updatePlayerMovement() {
    const inputX = (INPUT.keys['ArrowRight'] || INPUT.keys['KeyD'] ? 1 : 0) - (INPUT.keys['ArrowLeft'] || INPUT.keys['KeyA'] ? 1 : 0);
    const inputY = (INPUT.keys['ArrowDown'] || INPUT.keys['KeyS'] ? 1 : 0) - (INPUT.keys['ArrowUp'] || INPUT.keys['KeyW'] ? 1 : 0);

    if (inputX !== 0 || inputY !== 0) {
        const len = Math.sqrt(inputX * inputX + inputY * inputY);
        const nx = inputX / len;
        const ny = inputY / len;
        const lvl = getCurrentLevelData();
        const baseZoom = lvl?.startZoom ?? 2.5;
        const zoomFactor = baseZoom / Math.max(currentZoom, 0.1);
        player.x += nx * player.speed * zoomFactor;
        player.y += ny * player.speed * zoomFactor;
        player.targetAngle = Math.atan2(ny, nx);
    }
}

/**
 * Handles player rotation smoothing and size growth toward target.
 */
function updatePlayerSizeAndAngle() {
    let angleDiff = player.targetAngle - player.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    player.angle += angleDiff * 0.2;

    if (state !== 'dying') {
        player.size += (player.targetSize - player.size) * 0.2;
    }
}

/**
 * Clamps player position to map bounds accounting for player size.
 */
function updatePlayerBounds() {
    const halfMap = MAP_SIZE / 2;
    const radius = entityRadius(player.size);
    const minX = width / 2 - halfMap + radius;
    const maxX = width / 2 + halfMap - radius;
    const minY = height / 2 - halfMap + radius;
    const maxY = height / 2 + halfMap - radius;
    player.x = Math.max(minX, Math.min(maxX, player.x));
    player.y = Math.max(minY, Math.min(maxY, player.y));

    const barrier = getActiveBarrier();
    if (barrier) {
        const r = entityRadius(player.size);
        const minX = width / 2 - barrier.halfW + r;
        const maxX = width / 2 + barrier.halfW - r;
        const minY = height / 2 - barrier.halfH + r;
        const maxY = height / 2 + barrier.halfH - r;
        player.x = Math.max(minX, Math.min(maxX, player.x));
        player.y = Math.max(minY, Math.min(maxY, player.y));
    }
}

/**
 * Keeps the camera center inside the active zoom barrier.
 */
function clampCameraToBarrier() {
    const barrier = getActiveBarrier();
    if (!barrier) return;
    const halfViewW = width / (2 * currentZoom);
    const halfViewH = height / (2 * currentZoom);
    const minX = width / 2 - barrier.halfW + halfViewW;
    const maxX = width / 2 + barrier.halfW - halfViewW;
    const minY = height / 2 - barrier.halfH + halfViewH;
    const maxY = height / 2 + barrier.halfH - halfViewH;
    if (minX > maxX) cameraX = width / 2;
    else cameraX = Math.max(minX, Math.min(maxX, cameraX));
    if (minY > maxY) cameraY = height / 2;
    else cameraY = Math.max(minY, Math.min(maxY, cameraY));
}


/**
 * Keeps the camera viewport inside the map border.
 */
function clampCameraToMapBounds() {
    const halfMap = MAP_SIZE / 2;
    const halfViewW = width / (2 * currentZoom);
    const halfViewH = height / (2 * currentZoom);
    const minX = width / 2 - halfMap + halfViewW;
    const maxX = width / 2 + halfMap - halfViewW;
    const minY = height / 2 - halfMap + halfViewH;
    const maxY = height / 2 + halfMap - halfViewH;

    cameraX = minX > maxX ? width / 2 : Math.max(minX, Math.min(maxX, cameraX));
    cameraY = minY > maxY ? height / 2 : Math.max(minY, Math.min(maxY, cameraY));
}

/**
 * Smoothly follows the player with the camera (unless dying).
 */
function updateCamera() {
    if (state !== 'dying') {
        cameraX += (player.x - cameraX) * 0.1;
        cameraY += (player.y - cameraY) * 0.1;
        currentZoom += (targetZoom - currentZoom) * 0.08;
        clampCameraToMapBounds();
        clampCameraToBarrier();
    }
}

/**
 * Starts the player death sequence and captures the run summary.
 */
function beginPlayerDeath() {
    if (state !== 'playing') return;
    state = 'dying';
    deathDelay = 0;
    summaryInputLock = 0;
    INPUT.mouse.down = false;
    INPUT.keys['Enter'] = false;
    saveGame(selectedSlot);
    summaryStats = {
        refinedMatter: refinedMatter,
        size: player.size,
        time: Math.max(0, Math.floor(levelTimer))
    };
    for (let i = 0; i < CONFIG.deathParticleCount; i++) {
        deathParticles.push({
            x: player.x,
            y: player.y,
            vx: (Math.random() - 0.5) * 12,
            vy: (Math.random() - 0.5) * 12,
            life: 1.0,
            color: '#ff0000',
            size: 2 + Math.random() * 4
        });
    }
}

/**
 * Updates foam entities: shake animation and player collision/eating.
 * Food larger than the player cannot be eaten: dangerous food kills on
 * contact, while non-dangerous food acts as a solid obstacle.
 */
function updateFoam() {
    const visualScale = getLevelVisualScale();
    for (let i = foam.length - 1; i >= 0; i--) {
        const f = foam[i];

        if (f.kind === 'bottom') {
            f.shakeX = 0;
            f.shakeY = 0;
        } else {
            f.shakeTimer += 0.2;
            f.shakeX = Math.sin(f.shakeTimer + f.shakeOffsetX) * 0.1;
            f.shakeY = Math.cos(f.shakeTimer * 1.3 + f.shakeOffsetY) * 0.1;
        }

        const fx = f.x + f.shakeX * visualScale;
        const fy = f.y + f.shakeY * visualScale;
        const dx = player.x - fx;
        const dy = player.y - fy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = entityRadius(player.size) + entityRadius(f.size);

        if (dist < minDist) {
            if (f.size > player.size) {
                if (f.dangerous) {
                    beginPlayerDeath();
                    return;
                }
                // Solid obstacle: push the player back out of its radius.
                const nx = dist > 0.0001 ? dx / dist : 1;
                const ny = dist > 0.0001 ? dy / dist : 0;
                player.x = fx + nx * minDist;
                player.y = fy + ny * minDist;
                updatePlayerBounds();
                continue;
            }

            refinedMatter += 1;
            player.targetSize += f.size * CONFIG.growthScale;
            lastEaten = f.kind || 'foam';
            const color = FOOD_INFO[lastEaten]?.color || '#ffffff';
            spawnParticles(f.x, f.y, CONFIG.particleCountPerFoam, color);
            foam.splice(i, 1);
        }
    }
}

/**
 * Updates particle lifecycle and removes expired particles.
 */
function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.05;
        if (p.life <= 0) particles.splice(i, 1);
    }
}

/**
 * Updates death particle lifecycle and removes expired particles.
 */
function updateDeathParticles() {
    for (let i = deathParticles.length - 1; i >= 0; i--) {
        const p = deathParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.04;
        if (p.life <= 0) deathParticles.splice(i, 1);
    }
}

/**
 * Handles death delay countdown and transition to summary screen.
 */
function updateDyingState() {
    if (state === 'dying') {
        deathDelay += 1;
        if (deathDelay >= CONFIG.deathDelayFrames) {
            state = 'summary';
            summaryInputLock = CONFIG.summaryInputLockFrames;
            INPUT.mouse.down = false;
            INPUT.keys['Enter'] = false;
        }
    }
}

/**
 * Advances the level timer while playing.
 */
function updateTimer() {
    levelTimer += (state === 'playing') ? 1 / 60 : 0;
}

/**
 * Spawns the adversary when the level time limit is reached.
 */
function updateAdversarySpawn() {
    if (!adversary && state === 'playing') {
        const timeLimit = getLevelTimeLimit();
        if (adversarySpawnHint === null && levelTimer >= timeLimit - 3) {
            const dx = player.x - width / 2;
            const dy = player.y - height / 2;
            let edge, side;
            if (Math.abs(dx) >= Math.abs(dy)) {
                edge = 'x';
                side = dx >= 0 ? -1 : 1;
            } else {
                edge = 'y';
                side = dy >= 0 ? -1 : 1;
            }
            adversarySpawnHint = { edge, side };
        }
        if (levelTimer >= timeLimit) {
            const lvl = levels.find(l => l.id === currentLevel);
            const thresholds = lvl?.zoomThresholds || [];
            const finalThreshold = thresholds.length ? thresholds[thresholds.length - 1] : null;
            if (finalThreshold && !(player.size >= finalThreshold.size)) {
                beginPlayerDeath();
                return;
            }
            const targetSize = lvl?.objective?.target ?? 10;
            const halfMap = MAP_SIZE / 2;
            const margin = entityRadius(targetSize) + 50;
            const spawnEdge = adversarySpawnHint?.edge ?? (Math.random() < 0.5 ? 'x' : 'y');
            const spawnSide = adversarySpawnHint?.side ?? (Math.random() < 0.5 ? -1 : 1);
            let x, y;
            if (spawnEdge === 'x') {
                x = width / 2 + spawnSide * (halfMap - margin);
                y = height / 2 + (Math.random() * 2 - 1) * (halfMap - margin);
            } else {
                x = width / 2 + (Math.random() * 2 - 1) * (halfMap - margin);
                y = height / 2 + spawnSide * (halfMap - margin);
            }
            adversary = {
                x: x,
                y: y,
                size: targetSize,
                speed: player.speed * CONFIG.adversarySpeedMultiplier,
                color: '#ff0000'
            };
            adversarySpawnHint = null;
        }
    }
}

/**
 * Updates adversary movement toward/away from player and handles win/death collision.
 * When player is bigger, adversary flees slower and stays inside map bounds.
 */
function updateAdversaryMovement() {
    if (adversary && state === 'playing') {
        const dx = player.x - adversary.x;
        const dy = player.y - adversary.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const fleeing = player.size >= adversary.size;
        // 0.4 of the doubled speed keeps the fleeing adversary slower than
        // the player, so the final chase can actually end.
        const moveSpeed = fleeing ? adversary.speed * 0.4 : adversary.speed;

        if (dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            // Fleeing: move opposite direction (away from player)
            const dirX = fleeing ? -nx : nx;
            const dirY = fleeing ? -ny : ny;
            adversary.x += dirX * moveSpeed;
            adversary.y += dirY * moveSpeed;
        }

        // Keep adversary inside map bounds
        const halfMap = MAP_SIZE / 2;
        const advRadius = entityRadius(adversary.size);
        const minX = width / 2 - halfMap + advRadius;
        const maxX = width / 2 + halfMap - advRadius;
        const minY = height / 2 - halfMap + advRadius;
        const maxY = height / 2 + halfMap - advRadius;
        adversary.x = Math.max(minX, Math.min(maxX, adversary.x));
        adversary.y = Math.max(minY, Math.min(maxY, adversary.y));

        if (dist < entityRadius(player.size) + entityRadius(adversary.size)) {
            if (player.size >= adversary.size) {
                // Eating the adversary is the only win. Grow by the same
                // rule as any other edible, then hold for the victory beat.
                const eatenSize = adversary.size;
                adversary = null;
                lastEaten = 'adversary';
                refinedMatter += 10;
                player.targetSize += eatenSize * CONFIG.growthScale;
                spawnParticles(player.x, player.y, CONFIG.particleCountPerFoam * 3, '#ff0000');
                spawnParticles(player.x, player.y, CONFIG.particleCountPerFoam * 3, '#ffffff');
                saveGame(selectedSlot);
                state = 'victory';
                victoryDelay = 0;
                INPUT.mouse.down = false;
            } else {
                beginPlayerDeath();
            }
        }
    }
}

/**
 * Main per-frame update loop. Delegates to state-specific sub-functions.
 */
function update() {
    if (state === 'title') return;
    if (state === 'level_select') return;
    if (state === 'upgrade') return;
    if (state === 'pause') return;
    if (state === 'options') return;
    if (state === 'slot_select') return;
    if (state === 'howto') return;
    if (state === 'delete_confirm') return;
    if (state === 'won') return;

    if (state === 'victory') {
        updatePlayerSizeAndAngle();
        applyZoomThresholds();
        updatePlayerBounds();
        updateCamera();
        updateParticles();
        updateDeathParticles();
        victoryDelay += 1;
        if (victoryDelay >= CONFIG.victoryDelayFrames) {
            victoryDelay = 0;
            if (!completedLevels.includes(currentLevel)) {
                completedLevels.push(currentLevel);
                keys += 1;
            }
            state = 'won';
            INPUT.mouse.down = false;
            saveGame(selectedSlot);
        }
        return;
    }

    updateSummary();

    if (state === 'summary') return;

    if (state !== 'dying') {
        updatePlayerMovement();
    }

    updatePlayerSizeAndAngle();
    applyZoomThresholds();
    if (currentLevel === 2 && player.size >= 100 && !bigNeutrinosSpawned) {
        bigNeutrinosSpawned = true;
        const halfMap = MAP_SIZE / 2;
        const margin = 500;
        for (let i = 0; i < 30; i++) {
            const side = i % 4;
            let x, y;
            if (side === 0) { x = width / 2 - halfMap + margin; y = height / 2 + (Math.random() * 2 - 1) * (halfMap - margin); }
            else if (side === 1) { x = width / 2 + halfMap - margin; y = height / 2 + (Math.random() * 2 - 1) * (halfMap - margin); }
            else if (side === 2) { x = width / 2 + (Math.random() * 2 - 1) * (halfMap - margin); y = height / 2 - halfMap + margin; }
            else { x = width / 2 + (Math.random() * 2 - 1) * (halfMap - margin); y = height / 2 + halfMap - margin; }
            const size = 60 + Math.random() * 40;
            foam.push(spawnFoam(size, 'neutrino', x, y, false));
        }
    }
    updatePlayerBounds();
    updateCamera();

    if (state === 'playing') updateFoam();
    updateParticles();
    updateDeathParticles();
    updateDyingState();
    updateTimer();
    updateAdversarySpawn();
    updateAdversaryMovement();
}

// ── Game Loop: Draw ──────────────────────────────────────────

/**
 * Main per-frame draw loop. Delegates to state-specific sub-functions.
 */
function draw() {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);

    if (state === 'title') {
        drawTitle();
        drawCrtBloom();
        return;
    }

    if (state === 'pause') {
        drawPause();
        drawCrtBloom();
        return;
    }

    if (state === 'howto') {
        drawHowToPlay();
        drawCrtBloom();
        return;
    }

    if (state === 'delete_confirm') {
        drawDeleteConfirm();
        drawCrtBloom();
        return;
    }

    if (state === 'slot_select') {
        drawSlotSelect();
        drawCrtBloom();
        return;
    }

    if (state === 'level_select') {
        drawLevelSelect();
        drawCrtBloom();
        return;
    }

    if (state === 'upgrade') {
        drawUpgrade();
        drawCrtBloom();
        return;
    }

    if (state === 'options') {
        drawOptions();
        drawCrtBloom();
        return;
    }

    if (state === 'summary') {
        drawSummary();
        drawCrtBloom();
        return;
    }

    if (state === 'won') {
        drawVictory();
        drawCrtBloom();
        return;
    }

    if (state === 'victory') {
        // Show the growth animation without the HUD (the timer is frozen).
        drawWorld();
        drawCrtBloom();
        drawHud();
        drawSizeProgressBar();
        drawLastEaten();
        return;
    }

    drawWorld();
    drawAdversaryArrow();
    drawAdversarySpawnGlow();
    drawCrtBloom();
    drawHud();
    drawSizeProgressBar();
    drawLastEaten();
}

/**
 * Draws the title screen with 3 buttons: Play, Options, and a no-op button.
 */
function drawTitle() {
    const cx = width / 2;
    const cy = height / 2 + scale(100);
    const btnW = scale(200);
    const btnH = scale(40);
    const gap = scale(10);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(48) + 'px monospace';
    ctx.fillText('eat stuff', cx, cy - scale(120));
    ctx.font = scale(20) + 'px monospace';
    ctx.fillText('a totally original idea', cx, cy - scale(60));
    ctx.textAlign = 'start';

    // Button 1: Play -> slot select
    const playX = cx - btnW / 2;
    const playY = cy - btnH - gap / 2;
    const playHover = INPUT.mouse.sx > playX && INPUT.mouse.sx < playX + btnW && INPUT.mouse.sy > playY && INPUT.mouse.sy < playY + btnH;
    ctx.fillStyle = playHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(playX, playY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(playX, playY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(18) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Play', cx, playY + btnH / 2 + scale(4));

    // Button 2: Options
    const optY = cy;
    const optHover = INPUT.mouse.sx > playX && INPUT.mouse.sx < playX + btnW && INPUT.mouse.sy > optY && INPUT.mouse.sy < optY + btnH;
    ctx.fillStyle = optHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(playX, optY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(playX, optY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Options', cx, optY + btnH / 2 + scale(4));

    // Button 3: How to Play
    const nilY = cy + btnH + gap / 2;
    const nilHover = INPUT.mouse.sx > playX && INPUT.mouse.sx < playX + btnW && INPUT.mouse.sy > nilY && INPUT.mouse.sy < nilY + btnH;
    ctx.fillStyle = nilHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(playX, nilY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(playX, nilY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('How to Play', cx, nilY + btnH / 2 + scale(4));

    // Handle clicks
    if (playHover && INPUT.mouse.down) {
        state = 'slot_select';
        INPUT.mouse.down = false;
    }
    if (optHover && INPUT.mouse.down) {
        optionsReturnState = 'title';
        state = 'options';
        INPUT.mouse.down = false;
    }
    if (nilHover && INPUT.mouse.down) {
        state = 'howto';
        INPUT.mouse.down = false;
    }
}

/**
 * Draws the how-to-play screen with game instructions and a back button.
 */
function drawHowToPlay() {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(32) + 'px monospace';
    ctx.fillText('How to Play', cx, cy - scale(180));

    ctx.font = scale(18) + 'px monospace';
    ctx.fillText('Use WASD or Arrow Keys to move.', cx, cy - scale(100));
    ctx.fillText('Eat objects to grow larger.', cx, cy - scale(60));
    ctx.fillText('Reach the target size to be able to eat it.', cx, cy - scale(20));
    ctx.fillText('After a certain amount of time an adversary will spawn', cx, cy + scale(20));
    ctx.fillText('and come to eat you. Eat it first to win.', cx, cy + scale(55));
    ctx.fillText(`don't you just love arbitrary time limits in nodelikes`, cx, cy + scale(95));
    ctx.textAlign = 'start';

    // Back button
    const backX = cx - scale(120);
    const backY = cy + scale(120);
    const backW = scale(240);
    const backH = scale(40);
    const backHover = INPUT.mouse.sx > backX && INPUT.mouse.sx < backX + backW && INPUT.mouse.sy > backY && INPUT.mouse.sy < backY + backH;

    ctx.fillStyle = backHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(backX, backY, backW, backH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(backX, backY, backW, backH);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('Back', cx, backY + backH / 2 + scale(4));

    if (backHover && INPUT.mouse.down) {
        state = 'title';
        INPUT.mouse.down = false;
    }
    ctx.textAlign = 'start';
}

/**
 * Draws the level select screen with canvas buttons for each level and a back button.
 */
function drawLevelSelect() {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const btnW = scale(220);
    const btnH = scale(44);
    const gap = scale(14);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(32) + 'px monospace';
    ctx.fillText('Level Select', cx, cy - scale(160));
    ctx.font = scale(20) + 'px monospace';
    ctx.fillText(`Refined Matter: ${refinedMatter}`, cx, cy - scale(100));
    ctx.textAlign = 'start';

    levels.forEach((l, i) => {
        const btnX = cx - btnW / 2;
        const btnY = cy - scale(30) + i * (btnH + gap);
        const unlocked = isLevelUnlocked(l.id);
        const hover = unlocked && INPUT.mouse.sx > btnX && INPUT.mouse.sx < btnX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;

        ctx.fillStyle = unlocked ? (hover ? '#444444' : '#2a2a2a') : '#1a1a1a';
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.strokeStyle = unlocked ? '#ffffff' : '#444444';
        ctx.lineWidth = scale(2);
        ctx.strokeRect(btnX, btnY, btnW, btnH);
        ctx.fillStyle = unlocked ? '#ffffff' : '#555555';
        ctx.font = scale(18) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(unlocked ? l.name : `${l.name} (Locked)`, cx, btnY + btnH / 2 + scale(4));

        if (unlocked && hover && INPUT.mouse.down) {
            state = 'playing';
            startLevel(l.id, selectedSlot);
            INPUT.mouse.down = false;
        }
    });

    // Back button
    const backX = cx - btnW / 2;
    const backY = cy + scale(40) + levels.length * (btnH + gap);
    const backHover = INPUT.mouse.sx > backX && INPUT.mouse.sx < backX + btnW && INPUT.mouse.sy > backY && INPUT.mouse.sy < backY + btnH;

    ctx.fillStyle = backHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(backX, backY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(backX, backY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Back', cx, backY + btnH / 2 + scale(4));

    if (backHover && INPUT.mouse.down) {
        goToUpgrade();
        INPUT.mouse.down = false;
    }
    ctx.textAlign = 'start';
}

/**
 * Draws the save slot selection screen with 3 slots and a back button.
 */
function drawSlotSelect() {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const btnH = scale(50);
    const gap = scale(15);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(32) + 'px monospace';
    ctx.fillText('Select Save Slot', cx, cy - scale(140));
    ctx.textAlign = 'start';

    for (let i = 0; i < 3; i++) {
        const slot = i + 1;
        const btnX = cx - scale(150);
        const btnW = scale(220);
        const btnY = cy - scale(40) + i * (btnH + gap);
        let raw = null;
        try {
            raw = localStorage.getItem(`eatStuffSave_${slot}`);
        } catch (e) {
            // storage unavailable: treat as empty
        }
        const hasSave = raw !== null;

        let label = `Slot ${slot}`;
        let textColor = '#ffffff';
        if (hasSave) {
            try {
                const data = JSON.parse(raw);
                label += ` Matter: ${data.refinedMatter ?? 0}`;
            } catch (e) {
                label += ' Corrupt';
                textColor = '#ff0000';
            }
        } else {
            label += ' Empty';
            textColor = '#cccccc';
        }

        const hover = INPUT.mouse.sx > btnX && INPUT.mouse.sx < btnX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
        ctx.fillStyle = hover ? '#444444' : '#2a2a2a';
        ctx.fillRect(btnX, btnY, btnW, btnH);
        const isActive = hasSave && slot === selectedSlot;
        ctx.strokeStyle = hasSave ? (hover || isActive ? '#00ff00' : '#ffffff') : '#666666';
        ctx.lineWidth = scale(2);
        ctx.strokeRect(btnX, btnY, btnW, btnH);
        ctx.fillStyle = textColor;
        ctx.font = scale(18) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, btnX + btnW / 2, btnY + btnH / 2 + scale(4));

        if (hover && INPUT.mouse.down) {
            selectedSlot = slot;
            loadGame(slot);
            goToUpgrade();
            INPUT.mouse.down = false;
        }

        // Delete button (X)
        const delW = scale(40);
        const delX = cx + scale(90);
        const delHover = INPUT.mouse.sx > delX && INPUT.mouse.sx < delX + delW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
        ctx.fillStyle = delHover ? '#660000' : '#330000';
        ctx.fillRect(delX, btnY, delW, btnH);
        ctx.strokeStyle = delHover ? '#ff0000' : '#660000';
        ctx.strokeRect(delX, btnY, delW, btnH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('X', delX + delW / 2, btnY + btnH / 2 + scale(3));

        if (delHover && INPUT.mouse.down && hasSave) {
            deleteConfirmSlot = slot;
            state = 'delete_confirm';
            INPUT.mouse.down = false;
        }
    }

    // Back button
    const backX = cx - scale(120);
    const backY = cy + scale(160);
    const backW = scale(240);
    const backH = scale(40);
    const backHover = INPUT.mouse.sx > backX && INPUT.mouse.sx < backX + backW && INPUT.mouse.sy > backY && INPUT.mouse.sy < backY + backH;

    ctx.fillStyle = backHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(backX, backY, backW, backH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(backX, backY, backW, backH);
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(18) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Back', cx, backY + backH / 2 + scale(4));

    if (backHover && INPUT.mouse.down) {
        state = 'title';
        INPUT.mouse.down = false;
    }
    ctx.textAlign = 'start';
}

/**
 * Draws the delete save slot confirmation dialog.
 */
function drawDeleteConfirm() {
    if (deleteConfirmSlot === null) {
        state = 'slot_select';
        return;
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const title = 'Delete Save Slot?';
    const message = `Slot ${deleteConfirmSlot} will be erased permanently.`;

    // Size the panel to the text instead of hardcoding a box the message
    // overflows (and make the buttons sit inside the border).
    ctx.font = scale(28) + 'px monospace';
    const titleW = ctx.measureText(title).width;
    ctx.font = scale(18) + 'px monospace';
    const messageW = ctx.measureText(message).width;
    const panelW = Math.max(scale(320), titleW, messageW) + scale(64);
    const panelH = scale(220);
    const px = cx - panelW / 2;
    const py = cy - panelH / 2;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(px, py, panelW, panelH);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(28) + 'px monospace';
    ctx.fillText(title, cx, py + scale(58));
    ctx.font = scale(18) + 'px monospace';
    ctx.fillText(message, cx, py + scale(108));

    const btnW = scale(120);
    const btnH = scale(40);
    const btnGap = scale(16);
    const btnY = py + panelH - scale(24) - btnH;
    const yesX = cx - btnGap / 2 - btnW;
    const noX = cx + btnGap / 2;

    // Yes button
    const yesHover = INPUT.mouse.sx > yesX && INPUT.mouse.sx < yesX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
    ctx.fillStyle = yesHover ? '#660000' : '#330000';
    ctx.fillRect(yesX, btnY, btnW, btnH);
    ctx.strokeStyle = yesHover ? '#ff0000' : '#660000';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(yesX, btnY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Yes', yesX + btnW / 2, btnY + btnH / 2 + scale(4));

    // No button
    const noHover = INPUT.mouse.sx > noX && INPUT.mouse.sx < noX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
    ctx.fillStyle = noHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(noX, btnY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(noX, btnY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('No', noX + btnW / 2, btnY + btnH / 2 + scale(4));

    ctx.textAlign = 'start';

    if (yesHover && INPUT.mouse.down) {
        if (deleteConfirmSlot !== null) {
            deleteSave(deleteConfirmSlot);
            deleteConfirmSlot = null;
        }
        state = 'slot_select';
        INPUT.mouse.down = false;
    }
    if (noHover && INPUT.mouse.down) {
        deleteConfirmSlot = null;
        state = 'slot_select';
        INPUT.mouse.down = false;
    }
}

/**
 * Returns the on-screen bounds of the upgrade tree panel.
 */
function getUpgradePanel() {
    const w = scale(420);
    const h = scale(360);
    return {
        w,
        h,
        x: width / 2 - w / 2,
        y: height / 2 - h / 2,
        cx: width / 2,
        cy: height / 2
    };
}

/**
 * Draws the upgrade tree screen with pan/zoom support.
 * Tree is contained in its own panel; headings sit above it.
 */

function getUpgradeStat(n) {
    const level = n.level || 0;
    if (n.id === 'speed') {
        const cur = player.speed / CONFIG.baseSpeed;
        const next = (player.speed + CONFIG.baseSpeed * 0.05) / CONFIG.baseSpeed;
        return { current: cur.toFixed(2) + 'x', next: next.toFixed(2) + 'x' };
    }
    if (n.id === 'growth') {
        const cur = CONFIG.growthScale;
        return { current: cur.toFixed(2), next: (cur + 0.01).toFixed(2) };
    }
    if (n.id === 'timer') {
        const cur = getLevelTimeLimit();
        return { current: cur + 's', next: (cur + 1) + 's' };
    }
    if (n.id === 'dummy') {
        const cur = 125 + (250 - 125) * (level / 5);
        const next = 125 + (250 - 125) * ((level + 1) / 5);
        return { current: cur.toFixed(0), next: next.toFixed(0) };
    }
    if (n.id === 'keyUpgrade') {
        return { current: level >= 1 ? 'On' : 'Off', next: 'On' };
    }
    return { current: level, next: level + 1 };
}

function drawUpgrade() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    // Panel bounds for the tree container (screen space)
    const { w: panelW, h: panelH, x: panelX, y: panelY } = getUpgradePanel();

    // Draw tree panel background and border
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    // Screen-space headings above the panel
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(34) + 'px monospace';
    ctx.fillText('Upgrade Tree', cx, panelY - scale(40));
    ctx.font = scale(22) + 'px monospace';
    ctx.fillText(`Refined Matter: ${refinedMatter}`, cx, panelY - scale(10));
    ctx.textAlign = 'start';

    // Player stats panel (screen-space top-left)
    const statsX = scale(24);
    const statsY = scale(44);
    const statsLineH = scale(22);
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(16) + 'px monospace';
    ctx.fillText(`Speed: ${(player.speed / CONFIG.baseSpeed).toFixed(2)}x`, statsX, statsY);
    ctx.fillText(`Growth: x${CONFIG.growthScale.toFixed(2)} scale`, statsX, statsY + statsLineH);
    ctx.fillText(`Safety Time: ${getLevelTimeLimit()}s`, statsX, statsY + statsLineH * 2);
    ctx.fillText(`Keys: ${keys}`, statsX, statsY + statsLineH * 3);

    // Tree drawing inside panel container
    ctx.save();
    // Clip to panel so panned/zoomed nodes are hidden beyond the border
    ctx.beginPath();
    ctx.rect(panelX, panelY, panelW, panelH);
    ctx.clip();
    // Translate into panel space, apply pan/zoom, then center within panel
    ctx.translate(panelX + panelW / 2 + treeX, panelY + panelH / 2 + treeY);
    ctx.scale(treeZoom, treeZoom);

    // Inverse-transform mouse into tree space for hover/click math.
    // The transform is translate(panelCenter + treePan) then scale(treeZoom),
    // so the panel offset must be subtracted before dividing by zoom.
    const treeMouseX = (INPUT.mouse.sx - (panelX + panelW / 2 + treeX)) / treeZoom;
    const treeMouseY = (INPUT.mouse.sy - (panelY + panelH / 2 + treeY)) / treeZoom;

    // Draw connector lines between nodes
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = scale(2);
    upgradeNodes.forEach(n => {
        if (n.requires) {
            const req = upgradeNodes.find(u => u.id === n.requires);
            if (req) {
                const reqMet = req.level >= 1;
                if (!reqMet) return;
                ctx.beginPath();
                ctx.moveTo(scale(n.x), scale(n.y));
                ctx.lineTo(scale(req.x), scale(req.y));
                ctx.stroke();
            }
        }
    });

    let hoveredUpgrade = null;

    upgradeNodes.forEach(n => {
        const wx = scale(n.x);
        const wy = scale(n.y);
        const nw = scale(n.w);
        const nh = scale(n.h);
        const hover = treeMouseX > wx - nw / 2 && treeMouseX < wx + nw / 2 &&
                      treeMouseY > wy - nh / 2 && treeMouseY < wy + nh / 2;
        const cost = n.baseCost * (n.level + 1);
        const isKeyCost = n.costType === 'key';
        const reqMet = !n.requires || upgradeNodes.find(u => u.id === n.requires)?.level >= 1;
        if (!reqMet) return;
        const canAfford = (isKeyCost ? keys >= cost : refinedMatter >= cost) && n.level < n.maxLevel && reqMet;
        const maxed = n.level >= n.maxLevel;
        if (hover) hoveredUpgrade = { n, wx, wy, nw, nh, canAfford, reqMet, maxed, cost, isKeyCost };

        ctx.save();
        ctx.translate(wx, wy);

        if (hover) {
            ctx.shadowBlur = scale(12);
            ctx.shadowColor = canAfford ? '#00ff00' : '#ff0000';
        }

        ctx.fillStyle = maxed ? '#444444' : (!canAfford ? '#1a1a1a' : hover ? '#333333' : '#222222');
        ctx.fillRect(-nw / 2, -nh / 2, nw, nh);
        ctx.strokeStyle = maxed ? '#666666' : (canAfford ? '#ffffff' : '#444444');
        ctx.lineWidth = scale(2);
        ctx.strokeRect(-nw / 2, -nh / 2, nw, nh);
        ctx.shadowBlur = 0;

        ctx.fillStyle = maxed ? '#aaaaaa' : (canAfford ? '#ffffff' : '#666666');
        ctx.font = scale(8) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.name || n.id, 0, -scale(4));
        ctx.fillText(`${n.level}/${n.maxLevel}`, 0, scale(14));

        const progress = n.level / n.maxLevel;
        const barW = nw * 0.8;
        const barH = scale(4);
        ctx.fillStyle = '#222222';
        ctx.fillRect(-barW / 2, nh / 2 + scale(22), barW, barH);
        ctx.fillStyle = canAfford ? '#00ff00' : '#666666';
        ctx.fillRect(-barW / 2, nh / 2 + scale(22), barW * progress, barH);

        ctx.restore();

    });

    if (hoveredUpgrade) {
        const { n, wx, wy, nw, nh, canAfford, reqMet, maxed, cost, isKeyCost } = hoveredUpgrade;
        const tooltipY = wy - nh / 2 - scale(60);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(wx - scale(110), tooltipY - scale(40), scale(220), scale(80));
        ctx.strokeStyle = canAfford ? '#00ff00' : '#ff0000';
        ctx.lineWidth = scale(1);
        ctx.strokeRect(wx - scale(110), tooltipY - scale(40), scale(220), scale(80));

        ctx.fillStyle = canAfford ? '#00ff00' : '#ff0000';
        ctx.font = scale(13) + 'px monospace';
        ctx.textAlign = 'center';
        const tooltipName = n.name || n.id;
        ctx.fillText(tooltipName, wx, tooltipY - scale(28));
        ctx.fillStyle = '#cccccc';
        ctx.font = scale(11) + 'px monospace';
        const desc = n.description || '';
        const words = desc.split(' ');
        let line = '';
        const lines = [];
        const maxWidth = scale(200);
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = w;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);
        let descY = tooltipY - scale(12);
        for (const l of lines.slice(0, 3)) {
            ctx.fillText(l, wx, descY);
            descY += scale(12);
        }
        const stat = getUpgradeStat(n);
        ctx.fillStyle = '#ffffff';
        ctx.font = scale(11) + 'px monospace';
        ctx.textAlign = 'center';
        if (n.level >= n.maxLevel) {
            ctx.fillText('Current: ' + stat.current, wx, descY + scale(2));
        } else {
            ctx.fillText('Current: ' + stat.current + '  Next: ' + stat.next, wx, descY + scale(2));
        }
        if (n.requires && !reqMet) {
            ctx.fillStyle = '#ff0000';
            ctx.font = scale(11) + 'px monospace';
            ctx.fillText(`Requires: ${n.requires}`, wx, tooltipY + scale(40));
        } else {
            ctx.fillStyle = maxed ? '#aaaaaa' : (canAfford ? '#ffffff' : '#888888');
            ctx.font = scale(12) + 'px monospace';
            ctx.fillText(maxed ? 'Max Level' : (isKeyCost ? `Cost: ${cost} Key` : `Cost: ${cost} Refined Matter`), wx, tooltipY + scale(40));
        }
        ctx.textAlign = 'start';
    }

    ctx.restore();

    // screen-space help text (not affected by tree transform)
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(16) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Wheel to Zoom • Drag to Pan • Click a Node to Upgrade', cx, panelY + panelH + scale(30));
    ctx.textAlign = 'start';

    // Top-right Title button
    const titleBtnW = scale(120);
    const titleBtnH = scale(36);
    const titleBtnX = width - titleBtnW - scale(24);
    const titleBtnY = scale(24);
    const titleBtnHover = INPUT.mouse.sx > titleBtnX && INPUT.mouse.sx < titleBtnX + titleBtnW && INPUT.mouse.sy > titleBtnY && INPUT.mouse.sy < titleBtnY + titleBtnH;
    ctx.fillStyle = titleBtnHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(titleBtnX, titleBtnY, titleBtnW, titleBtnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(titleBtnX, titleBtnY, titleBtnW, titleBtnH);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('Title', titleBtnX + titleBtnW / 2, titleBtnY + titleBtnH / 2 + scale(4));

    if (titleBtnHover && INPUT.mouse.down) {
        state = 'title';
        INPUT.mouse.down = false;
    }

    // Bottom Level Select button
    const lvlBtnW = scale(160);
    const lvlBtnH = scale(36);
    const lvlBtnX = cx - lvlBtnW / 2;
    const lvlBtnY = panelY + panelH + scale(50);
    const lvlBtnHover = INPUT.mouse.sx > lvlBtnX && INPUT.mouse.sx < lvlBtnX + lvlBtnW && INPUT.mouse.sy > lvlBtnY && INPUT.mouse.sy < lvlBtnY + lvlBtnH;
    ctx.fillStyle = lvlBtnHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(lvlBtnX, lvlBtnY, lvlBtnW, lvlBtnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(lvlBtnX, lvlBtnY, lvlBtnW, lvlBtnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Level Select', lvlBtnX + lvlBtnW / 2, lvlBtnY + lvlBtnH / 2 + scale(4));

    if (lvlBtnHover && INPUT.mouse.down) {
        state = 'level_select';
        INPUT.mouse.down = false;
    }
    ctx.textAlign = 'start';
}
/**
 * Draws the options menu with CRT bloom toggle.
 */
function drawOptions() {
    const cx = width / 2;
    const cy = height / 2;
    const panelW = scale(400);
    const panelH = scale(260);
    const px = cx - panelW / 2;
    const py = cy - panelH / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(px, py, panelW, panelH);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(28) + 'px monospace';
    ctx.fillText('Options', cx, cy - scale(90));

    const rowY = cy - scale(20);
    const labelX = cx - scale(80);
    const toggleX = cx + scale(10);
    const toggleW = scale(100);
    const toggleH = scale(40);
    const toggleHover = INPUT.mouse.sx > toggleX && INPUT.mouse.sx < toggleX + toggleW && INPUT.mouse.sy > rowY - toggleH / 2 && INPUT.mouse.sy < rowY + toggleH / 2;

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.font = scale(18) + 'px monospace';
    ctx.fillText('CRT BLOOM', labelX, rowY + scale(6));
    ctx.textAlign = 'start';

    // switch track (beginPath first: roundRect appends to the current path)
    ctx.fillStyle = crtBloom ? '#003300' : '#222222';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(toggleX, rowY - toggleH / 2, toggleW, toggleH, toggleH / 2);
    } else {
        ctx.beginPath();
        ctx.moveTo(toggleX + toggleH / 2, rowY - toggleH / 2);
        ctx.lineTo(toggleX + toggleW - toggleH / 2, rowY - toggleH / 2);
        ctx.arcTo(toggleX + toggleW, rowY - toggleH / 2, toggleX + toggleW, rowY, toggleH / 2);
        ctx.arcTo(toggleX + toggleW, rowY + toggleH / 2, toggleX + toggleW - toggleH / 2, rowY + toggleH / 2, toggleH / 2);
        ctx.arcTo(toggleX, rowY + toggleH / 2, toggleX, rowY, toggleH / 2);
        ctx.arcTo(toggleX, rowY - toggleH / 2, toggleX + toggleH / 2, rowY - toggleH / 2, toggleH / 2);
        ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = crtBloom ? '#00ff00' : '#555555';
    ctx.lineWidth = scale(2);
    ctx.stroke();

    // switch knob
    const knobRadius = toggleH / 2 - scale(4);
    const knobX = toggleX + (crtBloom ? toggleW - knobRadius : knobRadius);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(knobX, rowY, knobRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = crtBloom ? '#00ff00' : '#888888';
    ctx.lineWidth = scale(2);
    ctx.stroke();

    ctx.fillStyle = crtBloom ? '#00ff00' : '#ffffff';
    ctx.fillText(crtBloom ? 'On' : 'Off', toggleX + toggleW + scale(14), rowY + scale(6));

    const backBtnX = cx - scale(80);
    const backBtnY = cy + scale(40);
    const backBtnW = scale(160);
    const backBtnH = scale(36);
    const backHover = INPUT.mouse.sx > backBtnX && INPUT.mouse.sx < backBtnX + backBtnW && INPUT.mouse.sy > backBtnY && INPUT.mouse.sy < backBtnY + backBtnH;

    ctx.fillStyle = backHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(backBtnX, backBtnY, backBtnW, backBtnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(backBtnX, backBtnY, backBtnW, backBtnH);
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(18) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Back', cx, backBtnY + backBtnH / 2 + scale(6));
    ctx.textAlign = 'start';

    ctx.fillStyle = '#ffffff';
    ctx.font = scale(14) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Press Esc to Return', cx, cy + scale(110));
    ctx.textAlign = 'start';

    if (toggleHover && INPUT.mouse.down) {
        crtBloom = !crtBloom;
        // Persist the setting only when this slot already exists; toggling
        // from the title screen shouldn't silently create a save slot.
        try {
            if (localStorage.getItem(`eatStuffSave_${selectedSlot}`) !== null) {
                saveGame(selectedSlot);
            }
        } catch (e) {
            // storage unavailable
        }
        INPUT.mouse.down = false;
    }
    if (backHover && INPUT.mouse.down) {
        state = optionsReturnState;
        INPUT.mouse.down = false;
    }
}

/**
 * Draws the death summary screen.
 */
function drawSummary() {
    if (!summaryStats) {
        goToUpgrade();
        return;
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(32) + 'px monospace';
    ctx.fillText(summaryStats.ended ? 'Run Ended' : 'You Were Eaten', cx, cy - scale(80));
    ctx.font = scale(20) + 'px monospace';
    ctx.fillText(`Refined Matter: ${summaryStats.refinedMatter}`, cx, cy - scale(30));
    ctx.fillText(`Size Reached: ${summaryStats.size.toFixed(2)} ${getSizeUnit()}`, cx, cy);
    ctx.fillText(`${summaryStats.ended ? 'Time Played' : 'Time Survived'}: ${summaryStats.time}s`, cx, cy + scale(30));

    // Canvas buttons for summary screen
    const btnW = scale(120);
    const btnH = scale(36);
    const gap = scale(12);
    const totalW = btnW * 3 + gap * 2;
    const btnX = cx - totalW / 2;
    const btnY = cy + scale(60);

    // Retry button
    const retryX = btnX;
    const retryHover = INPUT.mouse.sx > retryX && INPUT.mouse.sx < retryX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
    ctx.fillStyle = retryHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(retryX, btnY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(retryX, btnY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Retry', retryX + btnW / 2, btnY + btnH / 2 + scale(4));

    // Upgrade button
    const upgX = btnX + btnW + gap;
    const upgHover = INPUT.mouse.sx > upgX && INPUT.mouse.sx < upgX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
    ctx.fillStyle = upgHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(upgX, btnY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(upgX, btnY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Upgrade', upgX + btnW / 2, btnY + btnH / 2 + scale(4));

    // Title button
    const titleX = btnX + (btnW + gap) * 2;
    const titleHover = INPUT.mouse.sx > titleX && INPUT.mouse.sx < titleX + btnW && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;
    ctx.fillStyle = titleHover ? '#444444' : '#2a2a2a';
    ctx.fillRect(titleX, btnY, btnW, btnH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2);
    ctx.strokeRect(titleX, btnY, btnW, btnH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Title', titleX + btnW / 2, btnY + btnH / 2 + scale(4));

    ctx.textAlign = 'start';

    // Handle clicks
    if (summaryInputLock <= 0 && retryHover && INPUT.mouse.down) {
        state = 'playing';
        startLevel(currentLevel, selectedSlot);
        INPUT.mouse.down = false;
    }
    if (summaryInputLock <= 0 && upgHover && INPUT.mouse.down) {
        state = 'upgrade';
        goToUpgrade();
        INPUT.mouse.down = false;
    }
    if (summaryInputLock <= 0 && titleHover && INPUT.mouse.down) {
        state = 'title';
        INPUT.mouse.down = false;
    }
}

/**
 * Draws the victory screen shown one second after eating the adversary.
 */
function drawVictory() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#00ff00';
    ctx.font = scale(48) + 'px monospace';
    ctx.fillText('You Win!', cx, cy - scale(110));

    ctx.fillStyle = '#ffffff';
    ctx.font = scale(20) + 'px monospace';
    ctx.fillText('You ate the adversary.', cx, cy - scale(55));
    ctx.fillText(`Refined Matter: ${refinedMatter}`, cx, cy - scale(5));
    ctx.fillText(`Size Reached: ${player.size.toFixed(2)} ${getSizeUnit()}`, cx, cy + scale(25));
    ctx.fillText(`Time: ${Math.floor(levelTimer)}s`, cx, cy + scale(55));

    const btnW = scale(120);
    const btnH = scale(36);
    const gap = scale(12);
    const totalW = btnW * 3 + gap * 2;
    const btnX = cx - totalW / 2;
    const btnY = cy + scale(100);
    const labels = ['Upgrade', 'Levels', 'Title'];

    ctx.font = scale(18) + 'px monospace';
    for (let i = 0; i < labels.length; i++) {
        const x = btnX + i * (btnW + gap);
        const hover = INPUT.mouse.sx > x && INPUT.mouse.sx < x + btnW
            && INPUT.mouse.sy > btnY && INPUT.mouse.sy < btnY + btnH;

        ctx.fillStyle = hover ? '#444444' : '#2a2a2a';
        ctx.fillRect(x, btnY, btnW, btnH);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = scale(2);
        ctx.strokeRect(x, btnY, btnW, btnH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labels[i], x + btnW / 2, btnY + btnH / 2 + scale(4));

        if (hover && INPUT.mouse.down) {
            INPUT.mouse.down = false;
            if (i === 0) {
                goToUpgrade();
            } else if (i === 1) {
                state = 'level_select';
            } else {
                state = 'title';
            }
        }
    }
    ctx.textAlign = 'start';
}

/**
 * Draws the pause menu with a vertical stack of actions.
 */
function drawPause() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = scale(32) + 'px monospace';
    ctx.fillText('Paused', cx, cy - scale(130));

    const buttons = [{ label: 'Options', action: 'options' }];
    if (previousState === 'playing') {
        buttons.unshift({ label: 'Resume', action: 'resume' });
        buttons.push({ label: 'End Current Run', action: 'end' });
    }
    buttons.push({ label: 'Return to Title', action: 'title' });

    const btnW = scale(240);
    const btnH = scale(40);
    const gap = scale(12);
    const totalH = buttons.length * btnH + (buttons.length - 1) * gap;
    const btnX = cx - btnW / 2;
    const btnY = cy - totalH / 2 + scale(8);

    ctx.font = scale(20) + 'px monospace';
    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        const y = btnY + i * (btnH + gap);
        const hover = INPUT.mouse.sx > btnX && INPUT.mouse.sx < btnX + btnW
            && INPUT.mouse.sy > y && INPUT.mouse.sy < y + btnH;

        ctx.fillStyle = hover ? '#444444' : '#2a2a2a';
        ctx.fillRect(btnX, y, btnW, btnH);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = scale(2);
        ctx.strokeRect(btnX, y, btnW, btnH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(button.label, btnX + btnW / 2, y + btnH / 2 + scale(7));

        if (hover && INPUT.mouse.down) {
            ctx.textAlign = 'start';
            INPUT.mouse.down = false;
            if (button.action === 'options') {
                // Don't touch previousState here: it is the "resume game" target.
                optionsReturnState = 'pause';
                state = 'options';
            } else if (button.action === 'resume') {
                state = previousState;
            } else if (button.action === 'end') {
                endCurrentRun();
            } else {
                saveGame(selectedSlot);
                state = 'title';
            }
            return;
        }
    }

    ctx.font = scale(14) + 'px monospace';
    ctx.fillStyle = '#888888';
    ctx.fillText('Press Esc to Resume', cx, btnY + totalH + scale(26));

    ctx.textAlign = 'start';
}

/**
 * Finds the largest edible foam entity near the player.
 */
function findLargestEdibleNearPlayer() {
    let best = null;
    let bestDist = Infinity;
    const barrier = getActiveBarrier();
    const dummyLevel = upgradeNodes.find(n => n.id === 'dummy')?.level ?? 0;
    const baseRadius = 125 + (250 - 125) * (dummyLevel / 5);
    const detectRadius = baseRadius + player.size * 10;
    const candidates = [...foam];
    if (adversary && player.size >= adversary.size) {
        candidates.push({ ...adversary, kind: 'adversary', color: adversary.color || '#ff0000', shakeX: 0, shakeY: 0 });
    }
    for (const f of candidates) {
        if (f.size > player.size) continue;
        if (barrier) {
            const r = entityRadius(f.size);
            if (f.x < width / 2 - barrier.halfW + r || f.x > width / 2 + barrier.halfW - r) continue;
            if (f.y < height / 2 - barrier.halfH + r || f.y > height / 2 + barrier.halfH - r) continue;
        }
        const dx = f.x - player.x;
        const dy = f.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > detectRadius) continue;
        if (!best || f.size > best.size || (f.size === best.size && dist < bestDist)) {
            best = f;
            bestDist = dist;
        }
    }
    return best;
}

/**
 * Draws the gameplay world: map border, foam, particles, death particles, player, adversary.
 */
function drawWorld() {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(currentZoom, currentZoom);
    ctx.translate(-cameraX, -cameraY);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(2) / currentZoom;
    ctx.strokeRect(width / 2 - MAP_SIZE / 2, height / 2 - MAP_SIZE / 2, MAP_SIZE, MAP_SIZE);

    const visualScale = getLevelVisualScale();
    for (const f of foam) {
        const vs = entityRadius(f.size);
        const drawX = f.kind === 'bottom' ? f.x : f.x + f.shakeX * visualScale;
        const drawY = f.kind === 'bottom' ? f.y : f.y + f.shakeY * visualScale;
        const info = FOOD_INFO[f.kind] || FOOD_INFO.foam;
        let drew = false;
        if (info.img) {
            drew = drawSprite(info.img, info.bounds, drawX, drawY, vs);
        }
        if (!drew) {
            ctx.beginPath();
            ctx.arc(drawX, drawY, vs, 0, Math.PI * 2);
            ctx.fillStyle = info.color;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = scale(1) / currentZoom;
            ctx.stroke();
        }
    }

    const keyOwned = upgradeNodes.find(n => n.id === 'keyUpgrade')?.level >= 1;
    if (keyOwned) {
        const target = findLargestEdibleNearPlayer();
        if (target !== arrowTarget) {
            if (target === null) {
                arrowPending = null;
                arrowFadingOut = true;
            } else if (arrowTarget === null) {
                arrowTarget = target;
                arrowOpacity = 0;
                arrowFadingOut = false;
            } else {
                arrowPending = target;
                arrowFadingOut = true;
            }
        }
        if (arrowFadingOut) {
            arrowOpacity -= 0.15;
            if (arrowOpacity <= 0) {
                arrowOpacity = 0;
                arrowFadingOut = false;
                arrowTarget = arrowPending;
                arrowPending = null;
                if (arrowTarget) arrowOpacity = 0;
            }
        } else if (arrowTarget) {
            arrowOpacity = Math.min(1, arrowOpacity + 0.15);
        }
        const arrowStillExists = arrowTarget && (arrowTarget === adversary || foam.includes(arrowTarget));
        if (arrowTarget && !arrowStillExists) {
            arrowTarget = null;
            arrowPending = null;
            arrowFadingOut = false;
            arrowOpacity = 0;
        }
        if (arrowTarget) {
            const tvs = entityRadius(arrowTarget.size);
            const tx = arrowTarget.kind === 'bottom' ? arrowTarget.x : arrowTarget.x + arrowTarget.shakeX * visualScale;
            const ty = arrowTarget.kind === 'bottom' ? arrowTarget.y : arrowTarget.y + arrowTarget.shakeY * visualScale;
            const pad = tvs + scale(1) / currentZoom;
            const corner = scale(4) / currentZoom;
            const objColor = arrowTarget.color || (FOOD_INFO[arrowTarget.kind] || FOOD_INFO.foam).color || '#ffffff';
            ctx.save();
            ctx.globalAlpha = Math.max(0, arrowOpacity);
            ctx.strokeStyle = objColor;
            ctx.lineWidth = scale(1) / currentZoom;
            ctx.beginPath();
            ctx.moveTo(tx - pad, ty - pad + corner); ctx.lineTo(tx - pad, ty - pad); ctx.lineTo(tx - pad + corner, ty - pad);
            ctx.moveTo(tx + pad - corner, ty - pad); ctx.lineTo(tx + pad, ty - pad); ctx.lineTo(tx + pad, ty - pad + corner);
            ctx.moveTo(tx + pad, ty + pad - corner); ctx.lineTo(tx + pad, ty + pad); ctx.lineTo(tx + pad - corner, ty + pad);
            ctx.moveTo(tx - pad + corner, ty + pad); ctx.lineTo(tx - pad, ty + pad); ctx.lineTo(tx - pad, ty + pad - corner);
            ctx.stroke();
            const dx = tx - player.x;
            const dy = ty - player.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const pr = entityRadius(player.size);
            const startX = player.x + ux * (pr + 8);
            const startY = player.y + uy * (pr + 8);
            const arrowLen = Math.min(len - pr - 8, scale(15) / currentZoom);
            const ax = startX + ux * arrowLen;
            const ay = startY + uy * arrowLen;
            ctx.strokeStyle = objColor;
            ctx.fillStyle = objColor;
            ctx.lineWidth = scale(1) / currentZoom;
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(ax, ay);
            ctx.stroke();
            const head = scale(5) / currentZoom;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - ux * head - uy * head * 0.5, ay - uy * head + ux * head * 0.5);
            ctx.lineTo(ax - ux * head + uy * head * 0.5, ay - uy * head - ux * head * 0.5);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    for (const p of particles) {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    for (const p of deathParticles) {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    if (state !== 'dying') {
        const vs = entityRadius(player.size);
        if (!drawSprite(playerImg, SPRITE_BOUNDS.player, player.x, player.y, vs, player.angle)) {
            ctx.beginPath();
            ctx.arc(player.x, player.y, vs, 0, Math.PI * 2);
            ctx.fillStyle = player.color;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = scale(2) / currentZoom;
            ctx.stroke();
        }
    }

    if (adversary) {
        const showSad = player.size >= adversary.size;
        const advImg = showSad ? sadversaryImg : adversaryImg;
        const vs = entityRadius(adversary.size);
        if (!drawSprite(advImg, SPRITE_BOUNDS.adversary, adversary.x, adversary.y, vs)) {
            ctx.beginPath();
            ctx.arc(adversary.x, adversary.y, vs, 0, Math.PI * 2);
            ctx.fillStyle = '#ff0000';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = scale(2) / currentZoom;
            ctx.stroke();
        }
    }
    ctx.restore();
}

/**
 * Draws an offscreen edge arrow pointing toward the adversary.
 */
function drawAdversaryArrow() {
    if (adversary && state === 'playing') {
        const screenX = (adversary.x - cameraX) * currentZoom + width / 2;
        const screenY = (adversary.y - cameraY) * currentZoom + height / 2;
        if (screenX < 0 || screenX > width || screenY < 0 || screenY > height) {
            const cx = width / 2;
            const cy = height / 2;
            const dx = adversary.x - cameraX;
            const dy = adversary.y - cameraY;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = dx / len;
            const ny = dy / len;
            const angle = Math.atan2(dy, dx);

            const margin = scale(30);
            const rx = width / 2 - margin;
            const ry = height / 2 - margin;

            let t = Infinity;
            if (nx > 0) t = Math.min(t, rx / nx);
            else if (nx < 0) t = Math.min(t, -rx / nx);
            if (ny > 0) t = Math.min(t, ry / ny);
            else if (ny < 0) t = Math.min(t, -ry / ny);

            const edgeX = cx + nx * t;
            const edgeY = cy + ny * t;

            ctx.save();
            ctx.translate(edgeX, edgeY);
            ctx.rotate(angle);
            ctx.fillStyle = '#ff0000';
            ctx.beginPath();
            ctx.moveTo(scale(12), 0);
            ctx.lineTo(-scale(10), scale(6));
            ctx.lineTo(-scale(10), -scale(6));
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = scale(1);
            ctx.stroke();
            ctx.restore();
        }
    }
}

/**
 * Draws a faint red glow on the edge the adversary will spawn from.
 */
function drawAdversarySpawnGlow() {
    if (!adversarySpawnHint || adversary) return;
    if (levelTimer < getLevelTimeLimit() - 3) return;
    const hint = adversarySpawnHint;
    const glowSize = scale(80);
    const glowLen = scale(200);
    let grad;
    if (hint.edge === 'x') {
        if (hint.side > 0) {
            grad = ctx.createLinearGradient(width, 0, width - glowSize, 0);
        } else {
            grad = ctx.createLinearGradient(0, 0, glowSize, 0);
        }
    } else {
        if (hint.side > 0) {
            grad = ctx.createLinearGradient(0, height, 0, height - glowSize);
        } else {
            grad = ctx.createLinearGradient(0, 0, 0, glowSize);
        }
    }
    grad.addColorStop(0, 'rgba(255, 0, 0, 0.18)');
    grad.addColorStop(1, 'rgba(255, 0, 0, 0)');
    ctx.fillStyle = grad;
    if (hint.edge === 'x') {
        const y = height / 2 - glowLen / 2;
        ctx.fillRect(hint.side > 0 ? width - glowSize : 0, y, glowSize, glowLen);
    } else {
        const x = width / 2 - glowLen / 2;
        ctx.fillRect(x, hint.side > 0 ? height - glowSize : 0, glowLen, glowSize);
    }
}

/**
 * Draws CRT bloom overlay (scanlines + vignette).
 */
function drawCrtBloom() {
    if (crtBloom) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(0, 0, width, height);
        for (let y = 0; y < height; y += scale(4)) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(0, y, width, scale(1));
        }
        const grad = ctx.createRadialGradient(width / 2, height / 2, width / 4, width / 2, height / 2, width / 2);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
    }
}

/**
 * Draws a small top-center indicator for the last thing the player ate.
 */
function drawLastEaten() {
    if (!lastEaten) return;
    const info = FOOD_INFO[lastEaten] || FOOD_INFO.foam;
    const iconR = scale(8);
    const padX = scale(8);
    const gap = scale(6);
    const panelH = scale(24);
    const y = scale(1);

    ctx.font = scale(12) + 'px monospace';
    const label = `${info.name}`;
    const textW = ctx.measureText(label).width;
    const panelW = padX * 2 + iconR * 2 + gap + textW;
    const x = width / 2 - panelW / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(x, y, panelW, panelH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = scale(1);
    ctx.strokeRect(x, y, panelW, panelH);

    const iconX = x + padX + iconR;
    const iconY = y + panelH / 2;
    let drew = false;
    if (info.img) {
        drew = drawSprite(info.img, info.bounds, iconX, iconY, iconR);
    }
    if (!drew) {
        ctx.beginPath();
        ctx.arc(iconX, iconY, iconR, 0, Math.PI * 2);
        ctx.fillStyle = info.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = scale(1);
        ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + padX + iconR * 2 + gap, iconY + scale(4));
    ctx.textAlign = 'center';
}

/**
 * Draws the heads-up display (refined matter, size, timer).
 */
function drawHud() {
    const timeLimit = getLevelTimeLimit();
    const unit = getSizeUnit();
    ctx.fillStyle = '#ffffff';
    ctx.font = scale(18) + 'px monospace';
    ctx.textAlign = 'start';
    ctx.fillText(`Refined Matter: ${refinedMatter}`, scale(24), scale(44));
    ctx.fillText(`Size: ${player.size.toFixed(2)} ${unit}`, scale(24), scale(76));
    if (adversary) {
        ctx.fillStyle = '#ff0000';
        ctx.fillText('THE ADVERSARY IS HERE.', scale(24), scale(108));
        // Show the adversary's actual size so the player can judge the matchup.
        ctx.textAlign = 'right';
        ctx.fillStyle = player.size >= adversary.size ? '#00ff00' : '#ff0000';
        ctx.fillText(`Adversary: ${adversary.size.toFixed(2)} ${unit}`, width - scale(24), scale(44));
        ctx.fillStyle = '#ffffff';
    } else if (levelTimer >= timeLimit) {
        ctx.fillStyle = '#ff0000';
        ctx.fillText('THE ADVERSARY IS COMING.', scale(24), scale(108));
        ctx.fillStyle = '#ffffff';
    } else {
        ctx.fillText(`Safety Time: ${Math.max(0, timeLimit - Math.floor(levelTimer))}s`, scale(24), scale(108));
    }
    ctx.textAlign = 'center';
}

/**
 * Draws the size progress bar toward level target.
 */
function drawSizeProgressBar() {
    const lvl = getCurrentLevelData();
    if (lvl && lvl.objective && lvl.objective.type === 'size') {
        const target = lvl.objective.target;
        const start = lvl.startingSize ?? 1;
        const span = target - start;
        const progress = span > 0
            ? Math.max(0, Math.min(1, (player.size - start) / span))
            : 0;
        const barW = scale(200);
        const barH = scale(10);
        const barX = scale(24);
        const barY = scale(150);
        ctx.fillStyle = '#222222';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = scale(1);
        ctx.strokeRect(barX, barY, barW, barH);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(barX, barY, barW * progress, barH);
        ctx.fillStyle = '#ffffff';
        ctx.font = scale(12) + 'px monospace';
        ctx.textAlign = 'start';
        ctx.fillText(`Target: ${target} ${getSizeUnit()}`, barX, barY - scale(7));
    }
    ctx.textAlign = 'center';
}

// ── Main Loop & Input ────────────────────────────────────────

// Fixed-step simulation so the game runs at the same speed regardless of
// monitor refresh rate (previously a 144 Hz display ran everything 2.4x fast).
const FIXED_STEP = 1 / 60;
let lastFrameTime = 0;
let stepAccumulator = 0;

function loop(now) {
    requestAnimationFrame(loop);
    if (lastFrameTime === 0) lastFrameTime = now;
    const elapsed = Math.min((now - lastFrameTime) / 1000, 0.25);
    lastFrameTime = now;
    stepAccumulator += elapsed;

    let steps = 0;
    while (stepAccumulator >= FIXED_STEP && steps < 5) {
        update();
        stepAccumulator -= FIXED_STEP;
        steps += 1;
    }
    draw();
}

window.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.code === 'Escape') {
        // Avoid a held mouse button "clicking" a button on the screen we
        // just navigated to.
        INPUT.mouse.down = false;
        treeDragging = false;
        treeDragStartPos = null;
        switch (state) {
            case 'options':
                state = optionsReturnState;
                break;
            case 'delete_confirm':
                deleteConfirmSlot = null;
                state = 'slot_select';
                break;
            case 'slot_select':
                state = 'title';
                break;
            case 'level_select':
                goToUpgrade();
                break;
            case 'summary':
            case 'won':
            case 'upgrade':
                state = 'level_select';
                break;
            case 'howto':
                state = 'title';
                break;
            case 'pause':
                state = previousState;
                break;
            case 'playing':
            case 'dying':
                previousState = state;
                state = 'pause';
                break;
            default:
                // title: no-op
                break;
        }
    }
    if (e.code === 'Enter' && state === 'title') {
        INPUT.mouse.down = false;
        state = 'slot_select';
    }
    if (e.code === 'Enter' && state === 'won') {
        INPUT.mouse.down = false;
        goToUpgrade();
    }
});
window.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    INPUT.mouse.sx = e.clientX - rect.left;
    INPUT.mouse.sy = e.clientY - rect.top;
});
window.addEventListener('mousedown', e => { if (e.button === 0) INPUT.mouse.down = true; });
window.addEventListener('mouseup', e => { if (e.button === 0) INPUT.mouse.down = false; });

window.addEventListener('wheel', e => {
    if (state !== 'upgrade') return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const panel = getUpgradePanel();
    if (mx < panel.x || mx > panel.x + panel.w || my < panel.y || my > panel.y + panel.h) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(0.5, Math.min(3, treeZoom + dir));
    const scaleChange = newZoom / treeZoom;
    // Keep the point under the cursor fixed. Pan is stored in screen space,
    // relative to the panel centre (the translate happens before the scale).
    const localX = mx - panel.cx;
    const localY = my - panel.cy;
    treeX = localX - (localX - treeX) * scaleChange;
    treeY = localY - (localY - treeY) * scaleChange;
    treeZoom = newZoom;
}, { passive: false });

window.addEventListener('mousedown', e => {
    if (state === 'upgrade' && e.button === 0) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const panel = getUpgradePanel();
        if (x < panel.x || x > panel.x + panel.w || y < panel.y || y > panel.y + panel.h) return;
        treeDragStartPos = { x, y };
        treeDragging = false;
    }
});
window.addEventListener('mousemove', e => {
    if (treeDragStartPos && !treeDragging) {
        const rect = canvas.getBoundingClientRect();
        const dx = e.clientX - rect.left - treeDragStartPos.x;
        const dy = e.clientY - rect.top - treeDragStartPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > 5) {
            treeDragging = true;
            treeDragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top, treeX, treeY };
        }
    }
    if (treeDragging && state === 'upgrade') {
        const rect = canvas.getBoundingClientRect();
        const dx = e.clientX - rect.left - treeDragStart.x;
        const dy = e.clientY - rect.top - treeDragStart.y;
        // Pan is applied before the zoom scale, so it is in screen pixels.
        treeX = treeDragStart.treeX + dx;
        treeY = treeDragStart.treeY + dy;
    }
});
window.addEventListener('mouseup', (e) => {
    if (state === 'upgrade' && !treeDragging && treeDragStartPos) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const panel = getUpgradePanel();
        if (mx >= panel.x && mx <= panel.x + panel.w && my >= panel.y && my <= panel.y + panel.h) {
            const treeMouseX = (mx - (panel.x + panel.w / 2 + treeX)) / treeZoom;
            const treeMouseY = (my - (panel.y + panel.h / 2 + treeY)) / treeZoom;
            for (const n of upgradeNodes) {
                const reqMet = !n.requires || upgradeNodes.find(u => u.id === n.requires)?.level >= 1;
                if (!reqMet) continue;
                const wx = scale(n.x);
                const wy = scale(n.y);
                const nw = scale(n.w);
                const nh = scale(n.h);
                if (treeMouseX > wx - nw / 2 && treeMouseX < wx + nw / 2 && treeMouseY > wy - nh / 2 && treeMouseY < wy + nh / 2) {
                    applyUpgrade(n.id);
                    break;
                }
            }
        }
    }
    treeDragging = false;
    treeDragStartPos = null;
    INPUT.mouse.down = false;
});

loadGame(selectedSlot);
requestAnimationFrame(loop);


