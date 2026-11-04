import { db, storage } from "./firebase.js";
import {
    ref,
    get,
    update,
    onValue,
    push,
    set,
    remove,
    onChildAdded,
    onChildChanged,
    query,
    limitToLast
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";
import {
    ref as storageRef,
    uploadBytesResumable,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { showToast, copyText } from "./ui.js";

/* =========================================================
   ROOM INIT — read code from URL
========================================================= */

const params   = new URLSearchParams(window.location.search);
const roomCode = params.get("code");

if (!roomCode) {
    window.location.href = "index.html";
}

const roomRef = ref(db, "rooms/" + roomCode);

/* =========================================================
   SESSION — who am I?
========================================================= */

function getMySlot() {
    return sessionStorage.getItem("playerSlot");
}

const isHost = sessionStorage.getItem("isHost") === "true";

/* =========================================================
   TIMING CONSTANTS
========================================================= */

const ROLL_DURATION = 950;  // ms — snappy "toss" animation duration; the cube is driven
                             // straight at the true result from frame one (see the
                             // "SYNCED DICE ROLL SYSTEM" section), so this no longer
                             // needs to be long enough to hide a "wrong then corrected"
                             // face — it's purely how long the toss flourish plays.
const TURN_SECONDS  = 45;   // per-turn countdown shown on each color's timer badge
const STALE_ROLL_MS = ROLL_DURATION + 4000; // safety window before any client can clear a stuck roll

// NEW: how long to wait, PAST the 45s deadline, before a client that is
// NOT the active player steps in and forces the timeout logic on the
// active player's behalf. This exists because previously ONLY the
// active player's own browser tab ever called handleTurnTimeout() — if
// that tab was closed, backgrounded, or just frozen, the 45s deadline
// simply never fired for anyone, and the game stalled forever. The
// grace window avoids two clients racing to act in the very first
// instant the timer hits zero (normal network/clock jitter).
const TIMEOUT_FALLBACK_GRACE_MS = 5000;

// NEW: number of consecutive turns a player can let expire WITHOUT ever
// rolling before they're automatically removed from the room.
const MAX_MISSED_TURNS = 2;

/* =========================================================
   UI ELEMENTS
========================================================= */

const joinCard      = document.getElementById("join-card");
const joinNameInput = document.getElementById("join-name");
const joinBtn       = document.getElementById("join-btn");
const joinNameError = document.getElementById("join-name-error");
const startGameBtn  = document.getElementById("start-game-btn");
const leaveRoomBtn  = document.getElementById("leave-room-btn");
const copyLinkBtn   = document.getElementById("copy-link-btn");
const copyCodeBtn   = document.getElementById("copy-code-btn");
const waitingMsg    = document.getElementById("waiting-message");
const playerCountChip = document.getElementById("player-count");
const gameStatusEl    = document.getElementById("game-status");

const gameContainer = document.getElementById("game-container");
const turnIndicator = document.getElementById("turn-indicator");

/* Per-color dice boxes */
const diceBoxes = {
    player1: document.getElementById("dice-box-player1"),
    player2: document.getElementById("dice-box-player2"),
    player3: document.getElementById("dice-box-player3"),
    player4: document.getElementById("dice-box-player4"),
};

/* Per-color 3D dice CUBES — the .die-cube element inside each dice box
   whose `transform: rotateX(...) rotateY(...)` is what actually shows
   a given face to the camera. See the "3D DICE — ROTATION ENGINE"
   section below for how these are driven. */
const diceCubes = {
    player1: document.getElementById("dice-cube-player1"),
    player2: document.getElementById("dice-cube-player2"),
    player3: document.getElementById("dice-cube-player3"),
    player4: document.getElementById("dice-cube-player4"),
};

/* Per-color turn-timer badges (45s countdown) */
const diceTimers = {
    player1: document.getElementById("dice-timer-player1"),
    player2: document.getElementById("dice-timer-player2"),
    player3: document.getElementById("dice-timer-player3"),
    player4: document.getElementById("dice-timer-player4"),
};

/* Result / ranking popup */
const resultModal      = document.getElementById("result-modal");
const modalIconEl       = document.getElementById("modal-icon");
const modalTitleEl      = document.getElementById("modal-title");
const modalRankingEl    = document.getElementById("modal-ranking");
const modalContinueBtn  = document.getElementById("modal-continue-btn");
const modalLeaveBtn     = document.getElementById("modal-leave-btn");

/* Leave Game button below the board. FIXED: this used to also look
   up a #leave-game-btn (a header button) that doesn't exist anywhere
   in room.html — that was dead code left over from before the button
   was moved below the board. Only the bottom button actually exists,
   so only that one is wired up here. It shares the same leaveRoom()
   handler as the waiting-room sidebar button and the result-popup's
   Leave Game button. */
const leaveGameBtnBottom = document.getElementById("leave-game-btn-bottom");

/* Confirm-leave modal elements */
const confirmLeaveModal = document.getElementById("confirm-leave-modal");
const confirmLeaveYesBtn = document.getElementById("confirm-leave-yes-btn");
const confirmLeaveNoBtn  = document.getElementById("confirm-leave-no-btn");

/* Set room code in header */
document.getElementById("room-code").textContent = roomCode;
document.getElementById("game-room-code").textContent = roomCode;

/* =========================================================
   DICE SOUND — Web Audio API instead of a plain <audio>
   element. HTMLMediaElement.play() has to spin up a fresh decode
   pipeline on every call, which is what was causing the noticeable
   lag on other/slower devices. Decoding the clip into an AudioBuffer
   ONCE up front, then firing it via a fresh AudioBufferSourceNode
   on every roll, plays back near-instantly on any device. Falls
   back to a plain <audio> element if Web Audio isn't available or
   the decode fails for some reason.
========================================================= */

let audioCtx        = null;
let diceSoundBuffer  = null;
const diceSoundFallback = new Audio("sounds/dice rolling.mp3");
diceSoundFallback.preload = "auto";

(async function initDiceAudio() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch("sounds/dice rolling.mp3");
        const arrayBuffer = await resp.arrayBuffer();
        diceSoundBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.warn("Web Audio dice-sound init failed, will use fallback <audio>:", e);
        audioCtx = null;
        diceSoundBuffer = null;
    }
})();

async function playDiceSound() {
    if (audioCtx && diceSoundBuffer) {
        // Mobile browsers suspend the AudioContext until a user gesture;
        // resume() here (called synchronously from the click handler) satisfies that.
        // Never await resume(): on a context that has no user gesture yet the
        // promise can stay pending, which would stall whatever called us.
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const source = audioCtx.createBufferSource();
        source.buffer = diceSoundBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } else {
        diceSoundFallback.currentTime = 0;
        diceSoundFallback.play().catch(() => {
            // Autoplay restrictions — safe to ignore, roll still works visually
        });
    }
}

/* =========================================================
   TAP SOUND — one hop = one tap. Same Web Audio approach as
   the dice sound above (decode once into a buffer, fire a fresh
   AudioBufferSourceNode per hop) so back-to-back taps fired quickly
   during a multi-step move never get cut off, stolen, or laggy —
   each hop gets its own independent, near-instant playback.
========================================================= */

let tapSoundBuffer = null;
const tapSoundFallback = new Audio("sounds/tap.mp3");
tapSoundFallback.preload = "auto";

(async function initTapAudio() {
    try {
        // Reuse the same AudioContext the dice sound already created
        // (falls back to making one here if that init failed/hasn't run yet).
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch("sounds/tap.mp3");
        const arrayBuffer = await resp.arrayBuffer();
        tapSoundBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.warn("Web Audio tap-sound init failed, will use fallback <audio>:", e);
        tapSoundBuffer = null;
    }
})();

/* =========================================================
   CAPTURE (KILL) SOUND — sharp impact when a token is captured
========================================================= */

let captureSoundBuffer = null;
const captureSoundFallback = new Audio("sounds/capture.mp3");
captureSoundFallback.preload = "auto";

(async function initCaptureAudio() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch("sounds/capture.mp3");
        const arrayBuffer = await resp.arrayBuffer();
        captureSoundBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.warn("Web Audio capture-sound init failed, will use fallback <audio>:", e);
        captureSoundBuffer = null;
    }
})();

async function playCaptureSound() {
    if (audioCtx && captureSoundBuffer) {
        if (audioCtx.state === "suspended") { audioCtx.resume().catch(() => {}); return; }
        const source = audioCtx.createBufferSource();
        source.buffer = captureSoundBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } else {
        captureSoundFallback.currentTime = 0;
        captureSoundFallback.play().catch(() => {});
    }
}

/* =========================================================
   HOME (FINISH) SOUND — triumphant chime when token reaches home
========================================================= */

let homeSoundBuffer = null;
const homeSoundFallback = new Audio("sounds/home.mp3");
homeSoundFallback.preload = "auto";

(async function initHomeAudio() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch("sounds/home.mp3");
        const arrayBuffer = await resp.arrayBuffer();
        homeSoundBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.warn("Web Audio home-sound init failed, will use fallback <audio>:", e);
        homeSoundBuffer = null;
    }
})();

async function playHomeSound() {
    if (audioCtx && homeSoundBuffer) {
        if (audioCtx.state === "suspended") { audioCtx.resume().catch(() => {}); return; }
        const source = audioCtx.createBufferSource();
        source.buffer = homeSoundBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } else {
        homeSoundFallback.currentTime = 0;
        homeSoundFallback.play().catch(() => {});
    }
}

async function playTapSound() {
    if (audioCtx && tapSoundBuffer) {
        // Tap sounds fire mid-animation: if audio isn't unlocked yet, skip the
        // tap (and try to unlock) instead of queueing a burst of old taps.
        if (audioCtx.state === "suspended") { audioCtx.resume().catch(() => {}); return; }
        const source = audioCtx.createBufferSource();
        source.buffer = tapSoundBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } else {
        // Clone the element so 2-3 taps fired in quick succession each
        // get their own independent playback instead of one shared
        // <audio> stealing/restarting itself via currentTime = 0.
        const clone = tapSoundFallback.cloneNode();
        clone.play().catch(() => {
            // Autoplay restrictions — safe to ignore, hop still plays visually
        });
    }
}

/* =========================================================
   3D DICE — ROTATION ENGINE
   Replaces the old unicode-glyph swap (⚀–⚅) with a real CSS 3D
   cube per color (markup: .dice-box > .die-scene > .die-cube > 6x
   .die-face, see room.html). No images/textures — pure CSS 3D
   transforms + a CSS-Grid pip layout on each face (room.css).

   ROTATION MATH
   Each face is PLACED (in room.css) with:
       rotate(θ_face) · translateZ(half-cube-size)
   To bring that face to point at the camera, the CUBE must be
   rotated by the INVERSE of θ_face — not θ_face again, which is
   the classic bug that lands the wrong (often mirrored) face.
   Working through all six faces gives this self-consistent table:

     face   placement rotation      cube rotation to show it
     1 front   none                    rotateX(0)      rotateY(0)
     2 top     rotateX(90deg)          rotateX(-90deg) rotateY(0)
     3 right   rotateY(90deg)          rotateX(0)      rotateY(-90deg)
     4 left    rotateY(-90deg)         rotateX(0)      rotateY(90deg)
     5 bottom  rotateX(-90deg)         rotateX(90deg)  rotateY(0)
     6 back    rotateY(180deg)         rotateX(0)      rotateY(180deg)
========================================================= */

const FACE_ROTATION = {
    1: { x: 0,   y: 0   },
    2: { x: -90, y: 0   },
    3: { x: 0,   y: -90 },
    4: { x: 0,   y: 90  },
    5: { x: 90,  y: 0   },
    6: { x: 0,   y: 180 }
};

/* Running rotation total PER COLOR — deltas are always ADDED on top
   of this (never reset to 0-359°), so a die always visibly spins
   forward toward its next face instead of ever snapping backward. */
const diceRotationState = {
    player1: { x: 0, y: 0 },
    player2: { x: 0, y: 0 },
    player3: { x: 0, y: 0 },
    player4: { x: 0, y: 0 }
};

/* Tracks the last face value actually painted onto each cube, so
   updateDiceBoxes() (which runs on every realtime Firebase update)
   only touches the transform when the face genuinely changed. */
let lastPaintedFace = { player1: 1, player2: 1, player3: 1, player4: 1 };

/* Smallest forward delta (in degrees) that lands `current + delta`
   on `targetMod360` (mod 360), plus any extra full spins requested. */
function angleTo(current, targetMod360, spins) {
    const base = ((targetMod360 - current) % 360 + 360) % 360;
    return current + base + (spins || 0) * 360;
}

/* Rotates a color's cube to show `face` (1-6). `opts.spins` adds
   extra full turns on top (used for the "rolling" flourish); `opts
   .transition` overrides the CSS transition timing; `opts.instant`
   applies the rotation with no transition at all (page-load state). */
function setDiceFace(slot, face, opts) {
    opts = opts || {};
    const cube = diceCubes[slot];
    if (!cube) return;

    const state  = diceRotationState[slot];
    const target = FACE_ROTATION[face] || FACE_ROTATION[1];

    state.x = angleTo(state.x, ((target.x % 360) + 360) % 360, opts.spins);
    state.y = angleTo(state.y, ((target.y % 360) + 360) % 360, opts.spins);

    cube.style.transition = opts.instant
        ? "none"
        : (opts.transition || "transform 350ms cubic-bezier(.22,.9,.24,1)");
    cube.style.transform = "rotateX(" + state.x + "deg) rotateY(" + state.y + "deg)";
}

/* Land every cube on face 1 at rest, with no transition, before the
   game (and therefore any real dice values) exists. */
Object.keys(diceCubes).forEach(slot => {
    setDiceFace(slot, 1, { instant: true });
});

/* =========================================================
   BOARD PATH — matches the real 15x15 grid in room.html
   (cell ids are "c-ROW-COL")

   This is the 52-cell shared outer track, traced clockwise
   starting at Red's launch square (6,1).
========================================================= */

const TRACK_PATH = [
    [6,1],[6,2],[6,3],[6,4],[6,5],
    [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
    [0,7],
    [0,8],
    [1,8],[2,8],[3,8],[4,8],[5,8],
    [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
    [7,14],
    [8,14],
    [8,13],[8,12],[8,11],[8,10],[8,9],
    [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
    [14,7],
    [14,6],
    [13,6],[12,6],[11,6],[10,6],[9,6],
    [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
    [7,0],
    [6,0]
]; // 52 entries, indices 0-51

/* Where each color enters the shared track (13 cells apart) */
const START_OFFSET = {
    player1: 0,   // red
    player2: 13,  // blue
    player3: 39,  // green
    player4: 26   // yellow
};

/* Each color's 5-cell home stretch, ordered from the branch point to the center */
const HOME_STRETCH = {
    player1: [[7,1],[7,2],[7,3],[7,4],[7,5]],       // red
    player2: [[1,7],[2,7],[3,7],[4,7],[5,7]],       // blue
    player3: [[13,7],[12,7],[11,7],[10,7],[9,7]],   // green
    player4: [[7,13],[7,12],[7,11],[7,10],[7,9]]    // yellow
};

/* Where tokens sit while parked at home (before rolling a 6) */
const HOME_PARK_CELLS = {
    player1: ["c-2-2", "c-2-3", "c-3-2", "c-3-3"],
    player2: ["c-2-11", "c-2-12", "c-3-11", "c-3-12"],
    player3: ["c-11-2", "c-11-3", "c-12-2", "c-12-3"],
    player4: ["c-11-11", "c-11-12", "c-12-11", "c-12-12"]
};

/* FINISH_SLOT_CELLS — individual outer-ring cells where each
   finished token (index === 56) is placed, one token per cell,
   instead of piling all 4 into the shared home circle/square. Red
   and Green use their corner's LEFT-hand outer column; Blue and
   Yellow use their corner's RIGHT-hand outer column. Order is
   top-to-bottom for the top corners (red/blue) and top-to-bottom
   for the bottom corners too (green/yellow) — the first token that
   color finishes goes in slot 0, the next in slot 1, etc. */
const FINISH_SLOT_CELLS = {
    player1: ["c-1-0",  "c-2-0",  "c-3-0",  "c-4-0"],   // red   (top-left corner, left column)
    player2: ["c-1-14", "c-2-14", "c-3-14", "c-4-14"],  // blue  (top-right corner, right column)
    player3: ["c-10-0", "c-11-0", "c-12-0", "c-13-0"],  // green (bottom-left corner, left column)
    player4: ["c-10-14","c-11-14","c-12-14","c-13-14"]  // yellow (bottom-right corner, right column)
};

const COLOR_MAP = {
    player1: "red",
    player2: "blue",
    player3: "green",
    player4: "yellow"
};

const PLAYER_LABELS = {
    player1: "Red",
    player2: "Blue",
    player3: "Green",
    player4: "Yellow"
};

/* Safe cells: every color's own launch square (colored star), plus
   the shared colorless star 8 steps further along the track — the
   same convention used by standard Ludo boards/engines. Tokens on
   any of these 8 cells can't be captured. */
const SAFE_CELLS = new Set();
for (const p of Object.keys(START_OFFSET)) {
    const offset     = START_OFFSET[p];
    const start      = TRACK_PATH[offset];
    const neutralStar = TRACK_PATH[(offset + 8) % 52];
    SAFE_CELLS.add(start.join(","));
    SAFE_CELLS.add(neutralStar.join(","));
}

/* mark the finish-slot cells with a class so room.css can show
   a faint flag watermark on them even before any token lands there. */
(function markFinishSlots() {
    for (const slot in FINISH_SLOT_CELLS) {
        for (const cellId of FINISH_SLOT_CELLS[slot]) {
            const el = document.getElementById(cellId);
            if (el) el.classList.add("finish-slot");
        }
    }
})();

/* relative token index meaning:
   -1        => parked at home
   0-50      => position on this color's 51-cell shared stretch
   51-55     => on this color's 5-cell home stretch
   56        => finished (home)
*/

function getAbsoluteCoord(player, relative) {
    if (relative >= 0 && relative <= 50) {
        const idx = (START_OFFSET[player] + relative) % 52;
        return TRACK_PATH[idx];
    }
    if (relative >= 51 && relative <= 55) {
        return HOME_STRETCH[player][relative - 51];
    }
    return null; // finished
}

function getCellEl(coord) {
    if (!coord) return null;
    return document.getElementById(`c-${coord[0]}-${coord[1]}`);
}

/* `maxPlayers` determines which seats are handed out.
   - Default (4, or unset): fills player2, then player3, then player4.
   - 2-player rooms: skip straight to player4 — the second seat is
     the corner DIAGONALLY OPPOSITE player1's red corner (top-left),
     i.e. the yellow bottom-right corner, instead of the adjacent
     blue top-right corner. player2/player3 are never assigned in
     this mode, so their seats/UI simply stay empty/hidden. */
function getNextPlayerSlot(players = {}, maxPlayers = 4) {
    if (maxPlayers === 2) {
        if (!players.player4) return "player4";
        return null;
    }
    if (!players.player2) return "player2";
    if (!players.player3) return "player3";
    if (!players.player4) return "player4";
    return null;
}

/* Skips any slot already listed in `finished` (players who have
   gotten all 4 tokens home have nothing left to do). */
function getNextTurn(turnOrder, activePlayers, current, finished = []) {
    const active = turnOrder.filter(slot => activePlayers[slot] && !finished.includes(slot));
    if (active.length === 0) return current;
    const index = active.indexOf(current);
    if (index === -1) return active[0];
    return active[(index + 1) % active.length];
}

function hasLegalMove(dice, tokens) {
    for (const key in tokens) {
        const idx = tokens[key].index;
        if (idx === -1 && dice === 6) return true;
        if (idx >= 0 && idx !== 56 && idx + dice <= 56) return true;
    }
    return false;
}

/* Finds the first token that has a legal move for the given dice
   value — used to auto-play a turn when the 45s timer runs out. */
function findFirstLegalToken(dice, tokens) {
    for (const key in tokens) {
        const idx = tokens[key].index;
        if (idx === -1 && dice === 6) return key;
        if (idx >= 0 && idx !== 56 && idx + dice <= 56) return key;
    }
    return null;
}

/* =========================================================
   RESULT / RANKING POPUP HELPERS
========================================================= */

function ordinal(n) {
    const suffixes = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

/* kind: "trophy" | "medal" | "flag" — drawn in room.css */
function setModalIcon(kind) {
    if (modalIconEl) modalIconEl.dataset.kind = kind;
}

function hideResultModal() {
    if (resultModal) resultModal.style.display = "none";
}

/* Popup shown when a player finishes but others are still playing.
   Only a "Continue Game" button — dismisses locally, game keeps going. */
function showInterimModal(slot, rank, players) {
    if (!resultModal) return;
    const name = players[slot]?.name || PLAYER_LABELS[slot];

    setModalIcon(rank === 1 ? "trophy" : "medal");
    modalTitleEl.textContent = rank === 1
        ? `${name} won!`
        : `${name} finished ${ordinal(rank)}`;

    modalRankingEl.style.display   = "none";
    modalRankingEl.innerHTML       = "";
    modalContinueBtn.style.display = "";
    modalLeaveBtn.style.display    = "none";

    resultModal.style.display = "flex";
}

/* Popup shown once only one player is left unfinished — the game
   is over. 2-player games just announce the winner; 3-4 player
   games show the full numbered / color-coded ranking. Only a
   "Leave Game" button — no more play after this. */
function showFinalModal(finalOrder, players) {
    if (!resultModal) return;

    modalContinueBtn.style.display = "none";
    modalLeaveBtn.style.display    = "";

    if (finalOrder.length <= 2) {
        const winner = finalOrder[0];
        const name   = players[winner]?.name || PLAYER_LABELS[winner];
        setModalIcon("trophy");
        modalTitleEl.textContent     = `${name} won!`;
        modalRankingEl.style.display = "none";
        modalRankingEl.innerHTML      = "";
    } else {
        setModalIcon("flag");
        modalTitleEl.textContent     = "Game over";
        modalRankingEl.style.display = "flex";
        modalRankingEl.innerHTML      = finalOrder.map((slot, i) => {
            const name  = players[slot]?.name || PLAYER_LABELS[slot];
            const color = COLOR_MAP[slot];
            return `
                <div class="rank-row">
                    <span class="rank-number">${i + 1}</span>
                    <span class="rank-dot rank-dot--${color}"></span>
                    <span class="rank-name">${escapeHtml(name)}</span>
                </div>`;
        }).join("");
    }

    resultModal.style.display = "flex";
}

/* Tracks how many finish-popups we've already shown locally, so the
   realtime listener doesn't re-show one on every unrelated update.
   Reset back to 0 whenever a fresh game starts. */
let lastShownFinishCount = 0;

function handleResultPopups(game, players) {
    const finishOrder = game.finishOrder || [];
    const gameOver     = !!game.gameOver;
    const finalOrder   = game.finalOrder || [];

    if (finishOrder.length === 0 && !gameOver) {
        lastShownFinishCount = 0;
        hideResultModal();
        return;
    }

    if (gameOver) {
        showFinalModal(finalOrder, players);
        lastShownFinishCount = finishOrder.length;
        return;
    }

    if (finishOrder.length > lastShownFinishCount) {
        const rank = finishOrder.length;
        const slot = finishOrder[rank - 1];
        showInterimModal(slot, rank, players);
        lastShownFinishCount = rank;
    }
}

/* =========================================================
   LEAVE ROOM (shared by the sidebar button, the in-game Leave
   Game button, and the popup button)
========================================================= */

/* =========================================================
   CONFIRM LEAVE MODAL
========================================================= */

function showConfirmLeaveModal() {
    if (!confirmLeaveModal) {
        // Fallback: if modal markup is missing, leave immediately
        executeLeaveRoom();
        return;
    }
    confirmLeaveModal.style.display = "flex";
    confirmLeaveNoBtn?.focus();
}

function hideConfirmLeaveModal() {
    if (confirmLeaveModal) confirmLeaveModal.style.display = "none";
}

/* The actual leave action — called ONLY after user confirms */
async function executeLeaveRoom() {
    hideConfirmLeaveModal();

    const mySlot = getMySlot();
    const myName = sessionStorage.getItem("playerName");

    if (mySlot) {
        try {
            await update(roomRef, { [`players/${mySlot}`]: null });
        } catch (e) {
            console.warn("Could not remove player from room:", e);
        }
        if (myName) pushSystemMessage(`🔴 ${myName} left the room`);
    }

    destroyChat(); // detach the chat listener before navigating away — prevents memory leaks

    sessionStorage.clear();
    window.location.href = "index.html";
}

/* Public-facing leave handler — shows confirmation first */
function leaveRoom() {
    showConfirmLeaveModal();
}

leaveRoomBtn?.addEventListener("click", leaveRoom);
leaveGameBtnBottom?.addEventListener("click", leaveRoom);  // Leave Game button below the board
modalLeaveBtn?.addEventListener("click", leaveRoom);

confirmLeaveYesBtn?.addEventListener("click", executeLeaveRoom);
confirmLeaveNoBtn?.addEventListener("click", hideConfirmLeaveModal);

modalContinueBtn?.addEventListener("click", hideResultModal);

/* =========================================================
   COPY ROOM LINK / CODE
========================================================= */

const copyTextToClipboard = copyText;

function flashCopied(btn, originalText) {
    if (!btn) return;
    const label = btn.querySelector(".btn__label") || btn;
    label.textContent = "Copied";
    btn.classList.add("is-done");
    showToast(originalText === "Copy link" ? "Invite link copied" : "Room code copied");
    setTimeout(() => {
        label.textContent = originalText;
        btn.classList.remove("is-done");
    }, 2200);
}

copyLinkBtn?.addEventListener("click", async () => {
    const base    = window.location.href.split("?")[0];
    const roomUrl = base + "?code=" + roomCode;
    await copyTextToClipboard(roomUrl);
    flashCopied(copyLinkBtn, "Copy Link");
});

copyCodeBtn?.addEventListener("click", async () => {
    await copyTextToClipboard(roomCode);
    flashCopied(copyCodeBtn, "Copy Code");
});

/* =========================================================
   JOIN ROOM
========================================================= */

joinBtn?.addEventListener("click", joinRoom);
joinNameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
joinNameInput?.addEventListener("input", () => {
    joinNameError.textContent = "";
    joinNameInput.removeAttribute("aria-invalid");
});

function setJoinBtnLabel(text) {
    const label = joinBtn?.querySelector(".btn__label");
    if (label) label.textContent = text;
}

/* Shows why the visitor can't be here, then sends them back to the home page. */
function leaveWithMessage(message) {
    showToast(message, "error", 2600);
    setTimeout(() => { window.location.href = "index.html"; }, 1800);
}

async function joinRoom() {
    const name = joinNameInput.value.trim();
    if (!name) {
        joinNameError.textContent = "Enter your name so friends know who you are.";
        joinNameInput.setAttribute("aria-invalid", "true");
        joinNameInput.focus();
        return;
    }
    joinNameError.textContent = "";
    joinNameInput.removeAttribute("aria-invalid");

    joinBtn.disabled = true;
    setJoinBtnLabel("Joining…");

    try {
        const snap = await get(roomRef);
        if (!snap.exists()) {
            leaveWithMessage("That room doesn't exist anymore.");
            return;
        }

        const room = snap.val();

        if (room.status === "playing") {
            leaveWithMessage("That game has already started.");
            return;
        }

        const slot = getNextPlayerSlot(room.players, room.maxPlayers);

        if (!slot) {
            leaveWithMessage("That room is full.");
            return;
        }

        await update(roomRef, {
            [`players/${slot}`]: {
                name,
                color: COLOR_MAP[slot],
                isHost: false,
                joinedAt: Date.now()
            }
        });

        sessionStorage.setItem("playerSlot", slot);
        sessionStorage.setItem("playerName", name);

        joinCard.style.display = "none";

        pushSystemMessage(`🟢 ${name} joined the room`);

    } catch (err) {
        console.error("Join failed:", err);
        showToast("Couldn't join the room. Check your connection and try again.", "error");
        joinBtn.disabled = false;
        setJoinBtnLabel("Join game");
    }
}

/* =========================================================
   START GAME
========================================================= */

startGameBtn?.addEventListener("click", async () => {
    if (!isHost) return;
    if (startGameBtn.getAttribute("aria-disabled") === "true") {
        showToast("You need at least 2 players to start", "error");
        return;
    }

    const room = latestRoom;
    if (!room) return;

    const players   = room.players || {};
    const turnOrder = room.turnOrder || ["player1", "player2", "player3", "player4"];
    const active    = turnOrder.filter(s => players[s]);

    const firstTurn = active[Math.floor(Math.random() * active.length)];

    await update(roomRef, {
        status:                "playing",
        "game/currentTurn":    firstTurn,
        "game/diceValue":      0,
        "game/diceRolled":     false,
        "game/rolling":        null,
        "game/turnStartedAt":  Date.now(),
        "game/winner":         null,
        "game/finishOrder":    [],
        "game/gameOver":       false,
        "game/finalOrder":     null,
        // NEW: per-player count of consecutive turns expired with no roll —
        // reset fresh at the start of every game. See MAX_MISSED_TURNS.
        "game/missedTurns":    { player1: 0, player2: 0, player3: 0, player4: 0 },
        "game/tokens/player1": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player2": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player3": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player4": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } }
    });

    pushSystemMessage("🎲 Game started!");
});

/* =========================================================
   SYNCED DICE ROLL SYSTEM
========================================================= */

let currentAnimatingSlot = null; // slot currently showing the synced roll animation locally
let animationStopTimeout  = null; // timeout that ends the active animation

function startDiceAnimation(slot, face) {
    const box  = diceBoxes[slot];
    const cube = diceCubes[slot];
    if (!box || !cube) return;

    currentAnimatingSlot = slot;
    box.classList.add("dice-rolling");
    playDiceSound();

    const state  = diceRotationState[slot];
    const target = FACE_ROTATION[face] || FACE_ROTATION[1];

    const spinsX = 2 + Math.floor(Math.random() * 2); // 2–3 extra full laps
    const spinsY = 3 + Math.floor(Math.random() * 2); // 3–4 extra full laps

    state.x = angleTo(state.x, ((target.x % 360) + 360) % 360, spinsX);
    state.y = angleTo(state.y, ((target.y % 360) + 360) % 360, spinsY);

    cube.style.transition = "transform " + ROLL_DURATION + "ms cubic-bezier(.22,.61,.36,1)";
    cube.style.transform  = "rotateX(" + state.x + "deg) rotateY(" + state.y + "deg)";

    lastPaintedFace[slot] = face; // cube is already headed to the correct face

    animationStopTimeout = setTimeout(() => {
        finishDiceAnimation(slot);
    }, ROLL_DURATION);
}

function stopDiceAnimation(slot) {
    const box = diceBoxes[slot];
    if (box) box.classList.remove("dice-rolling");
    if (animationStopTimeout) { clearTimeout(animationStopTimeout); animationStopTimeout = null; }
    if (currentAnimatingSlot === slot) currentAnimatingSlot = null;
}

function finishDiceAnimation(slot) {
    stopDiceAnimation(slot);

    const mySlot = getMySlot();
    if (slot === mySlot) {
        finalizeRoll(slot);
    }
}

function syncDiceRollingAnimation(game) {
    const rolling = game.rolling;

    if (!rolling || !rolling.slot) {
        if (currentAnimatingSlot) stopDiceAnimation(currentAnimatingSlot);
        return;
    }

    if (rolling.slot === currentAnimatingSlot) return; // already animating this exact roll

    if (currentAnimatingSlot) stopDiceAnimation(currentAnimatingSlot);
    startDiceAnimation(rolling.slot, rolling.value || 1);
}

function finalizeRoll(mySlot) {
    const room = latestRoom;
    const game = latestGame;
    const turnOrder = (room && room.turnOrder) || ["player1", "player2", "player3", "player4"];

    if (!game || !game.rolling || game.rolling.slot !== mySlot) return;

    const dice = game.rolling.value;

    if (game.currentTurn !== mySlot) {
        update(roomRef, { "game/rolling": null }).catch(err =>
            console.error("Failed to clear stale rolling flag:", err)
        );
        return;
    }

    if (!hasLegalMove(dice, game.tokens[mySlot])) {
        const finishOrder = game.finishOrder || [];
        const nextTurn    = getNextTurn(turnOrder, room.players, mySlot, finishOrder);
        update(roomRef, {
            "game/rolling":       null,
            "game/diceValue":     dice,
            "game/diceRolled":    false,
            "game/currentTurn":   nextTurn,
            "game/turnStartedAt": Date.now()
        }).catch(err => console.error("Failed to sync no-legal-move roll:", err));
        return;
    }

    // Only one token can legally move? Nothing to choose — play it the
    // instant the dice finish, in a single write (no "diceRolled" round-trip,
    // no delay).
    const legal = legalTokenKeys(dice, game.tokens[mySlot]);
    if (legal.length === 1) {
        performMove(mySlot, legal[0], { ...room, game: { ...game, diceValue: dice } })
            .catch(err => console.error("Failed to auto-move only playable token:", err));
        return;
    }

    update(roomRef, {
        "game/rolling":    null,
        "game/diceValue":  dice,
        "game/diceRolled": true
    }).catch(err => console.error("Failed to sync roll result:", err));
}

/* Tokens that have a legal move for this roll. */
function legalTokenKeys(dice, tokens) {
    const keys = [];
    for (const key in tokens) {
        const idx = tokens[key].index;
        if ((idx === -1 && dice === 6) || (idx >= 0 && idx !== 56 && idx + dice <= 56)) keys.push(key);
    }
    return keys;
}

/* =========================================================
   BOARD-ANIMATION LOCK
========================================================= */

let boardAnimationCount = 0;

function isBoardAnimating() {
    return boardAnimationCount > 0;
}

/* Click handler shared by all 4 dice boxes. Only fires for real if
   the clicked box belongs to the LOCAL player's own color, it's
   currently that color's turn, and no roll is already in progress. */
async function handleDiceClick(slot) {
    const mySlot = getMySlot();
    if (!mySlot) return;
    if (slot !== mySlot) return;
    if (!latestGame) return;
    if (isBoardAnimating()) return; // a token is still hopping across the board — wait for it to land

    const game = latestGame;
    const room = latestRoom;
    if (!room) return;

    if (game.currentTurn !== mySlot)          return;
    if (game.diceRolled)                      return;
    if (game.gameOver)                        return;
    if (game.rolling && game.rolling.slot)    return; // a roll is already in flight

    const dice = Math.floor(Math.random() * 6) + 1;

    try {
        await update(roomRef, {
            "game/rolling": { slot: mySlot, startedAt: Date.now(), value: dice },
            // NEW: actually rolling proves this player showed up for their
            // turn — reset their consecutive-missed-turn counter so a run
            // of active turns can never accumulate toward an auto-kick.
            [`game/missedTurns/${mySlot}`]: 0
        });
    } catch (e) {
        console.error("Failed to start dice roll:", e);
    }
}

Object.keys(diceBoxes).forEach(slot => {
    diceBoxes[slot]?.addEventListener("click", () => handleDiceClick(slot));
    // keyboard: Enter / Space roll the die (handleDiceClick still enforces every rule)
    diceBoxes[slot]?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleDiceClick(slot);
        }
    });
});

/* =========================================================
   MOVE + CAPTURE SYSTEM
========================================================= */

async function handleTokenClick(player, tokenKey) {
    const mySlot = getMySlot();
    if (!mySlot) return;
    if (isBoardAnimating()) return; // block moving another token mid-hop (e.g. during an extra turn)

    const room = latestRoom;
    const game = latestGame;
    if (!room || !game) return;

    if (game.currentTurn !== mySlot) return;
    if (player !== mySlot)           return;
    if (!game.diceRolled)            return;
    if (game.gameOver)               return;

    const dice  = game.diceValue;
    const index = game.tokens[player][tokenKey].index;

    if (index === 56) return;              // already home
    if (index === -1 && dice !== 6) return; // can't leave home without a 6
    if (index >= 0 && index + dice > 56) return; // overshoot, illegal move

    await performMove(player, tokenKey, room);
}

/* Shared by manual token clicks AND the 45s auto-timeout, so both
   paths use exactly the same move/capture/finish logic. */
async function performMove(player, tokenKey, room) {
    const game      = room.game;
    const turnOrder = room.turnOrder || ["player1", "player2", "player3", "player4"];
    const dice      = game.diceValue;

    let index = game.tokens[player][tokenKey].index;
    index = (index === -1) ? 0 : index + dice;
    if (index > 56) return; // safety guard

    const captureUpdates = {};
    let capturedSlots = []; // track which opponents were captured for animation/sound

    /* Only cells on the shared track (0-50) are capturable */
    if (index >= 0 && index <= 50) {
        const [row, col] = getAbsoluteCoord(player, index);
        const landingKey = `${row},${col}`;

        if (!SAFE_CELLS.has(landingKey)) {
            for (const p in game.tokens) {
                if (p === player) continue;
                for (const t in game.tokens[p]) {
                    const theirIndex = game.tokens[p][t].index;
                    if (theirIndex < 0 || theirIndex > 50) continue;
                    const theirCoord = getAbsoluteCoord(p, theirIndex);
                    if (theirCoord[0] === row && theirCoord[1] === col) {
                        captureUpdates[`game/tokens/${p}/${t}/index`] = -1;
                        capturedSlots.push({ player: p, tokenKey: t });
                    }
                }
            }
        }
    }

  // Trigger capture animation locally.
// Sound is synchronized through Firebase.
if (capturedSlots.length > 0) {
    capturedSlots.forEach(({ player: p, tokenKey: t }) => {
        triggerCaptureAnimation(p, t);
    });
}

    const myTokens = { ...game.tokens[player], [tokenKey]: { index } };
    const allHome  = Object.values(myTokens).every(t => t.index === 56);

    /* ---- Finish-order / ranking bookkeeping ---- */
    const prevFinishOrder = game.finishOrder || [];
    const finishOrder = (allHome && !prevFinishOrder.includes(player))
        ? [...prevFinishOrder, player]
        : prevFinishOrder;

    const activeSlots     = turnOrder.filter(slot => room.players[slot]);
    const remainingActive = activeSlots.filter(slot => !finishOrder.includes(slot));

    let gameOver   = false;
    let finalOrder = finishOrder;

    if (remainingActive.length <= 1) {
        gameOver   = true;
        finalOrder = remainingActive.length === 1
            ? [...finishOrder, remainingActive[0]]
            : finishOrder;
    }

    // A token that just completed its full journey home (this move
    // landed it exactly on index 56) earns a bonus extra turn, same
    // family as rolling a 6 or landing a capture — UNLESS this was also
    // that player's very last token (allHome), in which case there's
    // nothing left for them to play and turn must pass.
    const tokenJustFinished = index === 56;

// Trigger home animation locally.
// Sound is synchronized through Firebase.
if (tokenJustFinished) {
    triggerHomeAnimation(player, tokenKey);
}

    const grantsExtraTurn = dice === 6 || Object.keys(captureUpdates).length > 0 || tokenJustFinished;

    let nextTurn;
    if (gameOver) {
        nextTurn = null;
    } else if (allHome) {
        nextTurn = getNextTurn(turnOrder, room.players, player, finishOrder);
    } else {
        nextTurn = grantsExtraTurn
            ? player
            : getNextTurn(turnOrder, room.players, player, finishOrder);
    }

    let soundEvent = null;

    if (capturedSlots.length > 0) {
        soundEvent = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: "capture",
            player,
            timestamp: Date.now()
        };
    } else if (tokenJustFinished) {
        soundEvent = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: "home",
            player,
            timestamp: Date.now()
        };
    }

    const moveUpdates = {
        ...captureUpdates,
        [`game/tokens/${player}/${tokenKey}/index`]: index,
        "game/rolling":       null,
        "game/diceValue":     0,
        "game/diceRolled":    false,
        "game/currentTurn":   nextTurn,
        "game/finishOrder":   finishOrder,
        "game/gameOver":      gameOver,
        "game/finalOrder":    gameOver ? finalOrder : null,
        "game/winner":        gameOver ? finalOrder[0] : null,
        "game/turnStartedAt": gameOver ? null : Date.now(),

        // Broadcast sound event to every player
        "game/soundEvent": soundEvent
    };

    await update(roomRef, moveUpdates);

    if (!gameOver && tokenJustFinished && !allHome) {
        const name = room.players[player]?.name || colorLabel(player);
        pushSystemMessage(`🎁 ${name}'s token made it home — bonus move!`);
    }

    if (gameOver && finalOrder && finalOrder.length) {
        const winnerSlot = finalOrder[0];
        const winnerName = room.players[winnerSlot]?.name || colorLabel(winnerSlot);
        pushSystemMessage(`🏆 ${winnerName} wins!`);
    }
}

/* =========================================================
   TURN TIMER + INACTIVITY AUTO-KICK

   `game/turnStartedAt` marks when the CURRENT turn began. Every
   client ticks a local interval that reads the elapsed time off
   that shared timestamp, so all devices count down in sync without
   needing per-tick database writes.

   FIXED: previously, ONLY the client whose color was actually up
   ever called handleTurnTimeout() when the countdown hit zero. If
   that specific player's tab was closed, backgrounded (many mobile
   browsers throttle/suspend JS timers in background tabs), or just
   froze, nobody else was watching — the 45s deadline simply never
   fired, and the game stalled on that player's turn forever. Now,
   after a short extra grace window past the deadline, ANY other
   connected client will force the exact same handleTurnTimeout()
   logic on the stalled player's behalf. Both paths write identical,
   derived-from-shared-state updates, so if two clients ever race to
   act, the second write just re-applies the same values — harmless.

   NEW: a player who lets a turn expire WITHOUT ever rolling has
   that counted against them in game/missedTurns/<slot>. Reaching
   MAX_MISSED_TURNS in a row (default 2) auto-kicks them from the
   room, same as if they'd clicked "Leave Game" themselves. Actually
   rolling resets their counter back to 0 (see handleDiceClick).
========================================================= */

let latestRoom   = null;
let latestGame   = null;
let latestPlayers = null;

let lastPlayedSoundEventId = null;
let soundEventListenerReady = false;

/* TWO-PLAYER MODE
   A room created for exactly 2 players (room.maxPlayers === 2) plays
   Red vs Yellow — player1 (red, top-left) and player4 (yellow,
   bottom-right), which are diagonally opposite corners on the board. */
let mode2p = false;

function colorLabel(slot) {
    return PLAYER_LABELS[slot];
}

/* Toggle a `turn-<color>` class on <body>, keyed off the current
   player, so room.css's turn-glow rules (top ambient glow, board
   edge glow, mobile board halo) recolor with whoever's turn it is.
   Cleared to nothing (falls back to the default brass glow) once
   the game is over, since there's no "current player" any more. */
function updateTurnGlow(currentTurn, gameOver) {
    const body = document.body;
    body.classList.remove("turn-red", "turn-blue", "turn-green", "turn-yellow");
    if (!gameOver && currentTurn && COLOR_MAP[currentTurn]) {
        body.classList.add(`turn-${COLOR_MAP[currentTurn]}`);
    }
}

let timeoutHandledForTurn = null; // the turnStartedAt value we've already auto-acted on

function updateTimerBadges(currentTurn, remaining, gameOver) {
    for (const slot of ["player1", "player2", "player3", "player4"]) {
        const badge = diceTimers[slot];
        if (!badge) continue;

        const isActive = !gameOver && slot === currentTurn;
        badge.classList.toggle("dice-timer--active", isActive);

        const box = diceBoxes[slot];

        if (isActive) {
            const shown = String(Math.max(0, remaining));
            if (badge.textContent !== shown) {
                badge.textContent = shown;
                badge.classList.toggle("dice-timer--warning", remaining <= 10);
                if (box) {
                    box.style.setProperty("--pct", String(Math.max(0, Math.min(1, remaining / TURN_SECONDS))));
                    box.classList.toggle("dice-box--timer-low", remaining <= 10);
                }
            }
        } else {
            badge.classList.remove("dice-timer--warning");
            box?.classList.remove("dice-box--timer-low");
        }
    }
}

function clearAllTimerBadges() {
    for (const slot of ["player1", "player2", "player3", "player4"]) {
        const badge = diceTimers[slot];
        if (!badge) continue;
        badge.classList.remove("dice-timer--active", "dice-timer--warning");
    }
}

/* Core timeout logic. `slot` is whichever color's turn actually
   expired — this may be called either by that player's OWN client
   (normal path) or, after the fallback grace window, by any OTHER
   connected client stepping in because the active player's client
   never acted (see tickTurnTimer()). */
async function handleTurnTimeout(slot) {
    const room = latestRoom;
    const game = latestGame;
    if (!room || !game || game.gameOver) return;
    if (game.currentTurn !== slot) return;
    if (game.rolling && game.rolling.slot) return; // mid-roll — let it resolve first

    const turnOrder   = room.turnOrder || ["player1", "player2", "player3", "player4"];
    const finishOrder = game.finishOrder || [];

    if (!game.diceRolled) {
        // Ran out of time before even rolling — genuine inactivity.
        // Track it, and auto-kick after MAX_MISSED_TURNS in a row.
        const missedTurns = game.missedTurns || {};
        const missedSoFar = (missedTurns[slot] || 0) + 1;

        if (missedSoFar >= MAX_MISSED_TURNS) {
            await kickPlayer(slot, room, game, turnOrder);
            return;
        }

        const nextTurn = getNextTurn(turnOrder, room.players, slot, finishOrder);
        await update(roomRef, {
            "game/diceValue":              0,
            "game/diceRolled":             false,
            "game/currentTurn":            nextTurn,
            "game/turnStartedAt":          Date.now(),
            [`game/missedTurns/${slot}`]:  missedSoFar
        });
        return;
    }

    // Dice was rolled but no move was made in time — auto-play the
    // first legal token. Rolling already counts as "showing up"
    // (handleDiceClick resets this player's missed-turn count to 0
    // the moment they roll), so this path never adds to the count.
    const dice     = game.diceValue;
    const tokens   = game.tokens[slot];
    const tokenKey = findFirstLegalToken(dice, tokens);

    if (tokenKey) {
        await performMove(slot, tokenKey, room);
    } else {
        const nextTurn = getNextTurn(turnOrder, room.players, slot, finishOrder);
        await update(roomRef, {
            "game/diceValue":     0,
            "game/diceRolled":    false,
            "game/currentTurn":   nextTurn,
            "game/turnStartedAt": Date.now()
        });
    }
}

/* NEW: INACTIVITY KICK
   Removes a no-show player from the room entirely — same effect as
   them clicking "Leave Game". getNextTurn() already skips any slot
   no longer present in room.players, so play continues around the
   vacated seat. If only one active player remains after the kick,
   the game ends immediately with that player as the winner. */
async function kickPlayer(slot, room, game, turnOrder) {
    const finishOrder = game.finishOrder || [];
    const name = room.players[slot]?.name || colorLabel(slot);

    const remainingPlayers = { ...room.players };
    delete remainingPlayers[slot];

    const remainingActive = turnOrder.filter(
        s => remainingPlayers[s] && !finishOrder.includes(s)
    );

    const gameOver = remainingActive.length <= 1;
    let finalOrder = finishOrder;
    let nextTurn    = null;

    if (gameOver) {
        finalOrder = remainingActive.length === 1
            ? [...finishOrder, remainingActive[0]]
            : finishOrder;
    } else {
        nextTurn = getNextTurn(turnOrder, remainingPlayers, slot, finishOrder);
    }

    await update(roomRef, {
        [`players/${slot}`]:          null,
        [`game/missedTurns/${slot}`]: null,
        "game/currentTurn":           gameOver ? null : nextTurn,
        "game/diceValue":             0,
        "game/diceRolled":            false,
        "game/rolling":               null,
        "game/gameOver":              gameOver,
        "game/finalOrder":            gameOver ? finalOrder : null,
        "game/winner":                gameOver ? finalOrder[0] : null,
        "game/turnStartedAt":         gameOver ? null : Date.now()
    });

    pushSystemMessage(`👢 ${name} was kicked for inactivity`);
}

function tickTurnTimer() {
    if (!latestGame || !latestRoom) return;
    const game = latestGame;

    if (latestRoom.status !== "playing" || game.gameOver) {
        clearAllTimerBadges();
        return;
    } 

    // Safety net: if a roll has been "in flight" way longer than it should
    // (the roller's device likely dropped), any client can clear it so the
    // game doesn't stall forever.
    if (game.rolling && game.rolling.startedAt) {
        const rollElapsed = Date.now() - game.rolling.startedAt;
        if (rollElapsed > STALE_ROLL_MS) {
            update(roomRef, { "game/rolling": null }).catch(() => {});
        }
    }

    const turnStartedAt = game.turnStartedAt;
    if (!turnStartedAt) {
        updateTimerBadges(game.currentTurn, TURN_SECONDS, false);
        return;
    }

    const elapsedMs = Date.now() - turnStartedAt;
    const remaining = Math.ceil(TURN_SECONDS - elapsedMs / 1000);
    updateTimerBadges(game.currentTurn, remaining, false);

    const mySlot    = getMySlot();
    const overdueMs = elapsedMs - TURN_SECONDS * 1000;

    if (overdueMs < 0 || timeoutHandledForTurn === turnStartedAt) return;

    if (mySlot === game.currentTurn) {
        // Normal path — the active player's own client handles its
        // own timeout, right at the 45s mark.
        timeoutHandledForTurn = turnStartedAt;
        handleTurnTimeout(mySlot);
    } else if (mySlot && overdueMs >= TIMEOUT_FALLBACK_GRACE_MS) {
        // FIXED: fallback takeover. If the active player's own client
        // hasn't acted within a few extra seconds past the deadline
        // (tab closed/backgrounded/frozen), any OTHER connected client
        // steps in and forces the same timeout logic on their behalf,
        // so the turn (and the game) is never stuck waiting on a client
        // that may never come back.
        timeoutHandledForTurn = turnStartedAt;
        handleTurnTimeout(game.currentTurn);
    }
}

setInterval(tickTurnTimer, 250);

/* =========================================================
   REALTIME SYNC — main listener
========================================================= */

let lastRoomSignature = null;

onValue(roomRef, (snap) => {
    if (!snap.exists()) return;

    const room    = snap.val();
    const players = room.players || {};
    const mySlot  = getMySlot();

    latestRoom    = room;
    latestGame    = room.game || null;
    latestPlayers = players;

    // Chat lives under this same room node, so every chat message, GIF and
    // reaction fires this listener. Re-running the whole game UI for those
    // was wasted work (and a source of hitching mid-animation) — skip the
    // event when nothing but chat changed.
    const { chat: _chat, ...roomWithoutChat } = room;
    const signature = mySlot + "|" + JSON.stringify(roomWithoutChat);
    if (signature === lastRoomSignature) return;
    lastRoomSignature = signature;

    // =========================================================
    // GLOBAL GAME SOUND SYNC
    // =========================================================

    const soundEvent = room.game?.soundEvent;

    if (!soundEventListenerReady) {
        // Don't play an old sound when joining/reloading.
        lastPlayedSoundEventId = soundEvent?.id || null;
        soundEventListenerReady = true;
    } else if (
        soundEvent &&
        soundEvent.id &&
        soundEvent.id !== lastPlayedSoundEventId
    ) {
        lastPlayedSoundEventId = soundEvent.id;

        if (soundEvent.type === "capture") {
            playCaptureSound();
        } else if (soundEvent.type === "home") {
            playHomeSound();
        }
    }

    // Keep the two-player mode flag in sync with the room's
    // configured capacity, and reflect it on <body> so room.css's
    // `body.mode-2p` override can hide the unused player2/player3
    // seats everywhere at once.
    mode2p = room.maxPlayers === 2;
    document.body.classList.toggle("mode-2p", mode2p);

    announcePlayerChanges(players);
    updatePlayerSlots(players);

    if (mySlot) {
        if (joinCard) joinCard.style.display = "none";
    } else {
        const filled = Object.keys(players).length;
        if (room.maxPlayers && filled >= room.maxPlayers && joinCard) {
            joinCard.style.display = "none";
        }
    }

    if (startGameBtn) {
        if (!isHost || room.status === "playing") {
            startGameBtn.style.display = "none";
        } else {
            startGameBtn.style.display = "";
            const count = Object.keys(players).length;
            if (count >= 2) {
                startGameBtn.classList.remove("btn-start--disabled");
                startGameBtn.removeAttribute("aria-disabled");
            } else {
                startGameBtn.classList.add("btn-start--disabled");
                startGameBtn.setAttribute("aria-disabled", "true");
            }
        }
    }

    {
        const count = Object.keys(players).length;
        const max   = room.maxPlayers || 4;
        const full  = count >= max;

        document.body.classList.toggle("is-full", full);
        if (playerCountChip) playerCountChip.textContent = `${count} of ${max}`;
        if (gameStatusEl) {
            gameStatusEl.textContent = room.status === "playing"
                ? "Game in progress"
                : full ? "Room is full" : "Waiting for players…";
        }

        if (waitingMsg) {
            if (room.status === "playing") {
                waitingMsg.style.display = "none";
            } else if (isHost) {
                waitingMsg.textContent = count < 2
                    ? "Share the code. You need at least 2 players to start."
                    : full
                        ? "Everyone's here. Start when you're ready."
                        : `You can start now, or wait for more players (${count} of ${max}).`;
            } else {
                waitingMsg.textContent = full
                    ? "Everyone's here. Waiting for the host to start."
                    : `Waiting for players (${count} of ${max})…`;
            }
        }
    }

    if (room.status === "playing" && room.game) {
        syncDiceRollingAnimation(room.game);
        showGameUI(room, players);
        // NOTE: result popups are no longer triggered from here directly.
        // renderTokens() (called from showGameUI when the board actually
        // changed) now owns when handleResultPopups() fires, so a finish/
        // win popup never appears until any in-flight token hop has
        // actually landed. See resolveResultPopups() below.
    }
});

/* =========================================================
   SHOW GAME UI
========================================================= */

let lastBoardRenderSignature = null;

function showGameUI(room, players) {
    document.querySelector(".page").style.display = "none";
    document.body.classList.add("in-game");
    // FIXED: this used to be "block", which silently killed the
    // flex-direction/align-items/gap rules room.css sets on
    // #game-container (they only apply when display is flex/grid).
    // Without flex, the header/board/leave-button stack lost its
    // gap and reliable centering, which is what made the mobile
    // layout look off — margins between them could collapse
    // instead of respecting the intended 14px gap.
    gameContainer.style.display = "flex";

    const game     = room.game;
    const mySlot   = getMySlot();
    const isMeTurn = game.currentTurn === mySlot;

    renderTurnIndicator(game, players, mySlot, isMeTurn);

    updateTurnGlow(game.currentTurn, game.gameOver);

    updateDiceBoxes(game, players, mySlot);

    const signature = JSON.stringify({
        tokens:     game.tokens,
        diceValue:  game.diceValue,
        diceRolled: game.diceRolled,
        gameOver:   game.gameOver
    });

    if (signature !== lastBoardRenderSignature) {
        lastBoardRenderSignature = signature;
        renderTokens(game);
    }

    updateTokenClickability(game, mySlot);

    updatePlayerPanels(game, players, mySlot);
}

/* Headline + hint above the board: whose turn, and what to do next. */
function renderTurnIndicator(game, players, mySlot, isMeTurn) {
    let text, hint = "";

    if (game.gameOver) {
        text = "Game over";
    } else {
        const rolling = !!(game.rolling && game.rolling.slot);
        const name    = players[game.currentTurn]?.name || colorLabel(game.currentTurn);

        if (isMeTurn) {
            text = "Your turn";
            hint = rolling ? "Rolling…" : game.diceRolled ? "Pick a token to move" : "Tap your die to roll";
        } else {
            text = `${name}'s turn`;
            hint = rolling ? "Rolling…" : game.diceRolled ? "Choosing a move" : "Waiting for a roll";
        }
    }

    const signature = text + "|" + hint + "|" + (isMeTurn ? "1" : "0");
    if (turnIndicator.dataset.sig === signature) return;
    turnIndicator.dataset.sig = signature;

    turnIndicator.classList.toggle("turn--mine", !!isMeTurn && !game.gameOver);
    turnIndicator.replaceChildren();

    const dot = document.createElement("span");
    dot.className = "turn__dot";
    const strong = document.createElement("span");
    strong.className = "turn__text";
    strong.textContent = text;
    turnIndicator.append(dot, strong);

    if (hint) {
        const h = document.createElement("span");
        h.className = "turn__hint";
        h.textContent = hint;
        turnIndicator.append(h);
    }
}

/* =========================================================
   UPDATE DICE BOXES
========================================================= */

function updateDiceBoxes(game, players, mySlot) {
    const locked = isBoardAnimating();

    for (const slot of ["player1", "player2", "player3", "player4"]) {
        const box = diceBoxes[slot];
        if (!box) continue;

        const playerExists = !!players[slot];
        box.classList.toggle("dice-box--empty", !playerExists);
        box.classList.toggle("dice-box--locked", locked);

        if (!playerExists) {
            box.classList.remove("dice-active", "dice-idle", "dice-box--mine");
            continue;
        }

        const isThisTurn = !game.gameOver && slot === game.currentTurn;

        box.classList.toggle("dice-active", isThisTurn);
        box.classList.toggle("dice-idle", !isThisTurn);
        box.classList.toggle("dice-box--mine", slot === mySlot);

        // "ready": it's my turn and the die is waiting for me to roll it
        const ready = slot === mySlot && isThisTurn && !game.diceRolled
                      && !locked && !(game.rolling && game.rolling.slot);
        box.classList.toggle("dice-box--ready", ready);
        box.tabIndex = ready ? 0 : -1;
        box.setAttribute("aria-disabled", ready ? "false" : "true");
        box.setAttribute("aria-label", ready ? `Roll your die` : `${PLAYER_LABELS[slot]} die`);

        // Don't stomp the cube while a synced rolling animation owns this box
        if (currentAnimatingSlot === slot) continue;

        if (isThisTurn) {
            const face = game.diceValue || 1;
            if (lastPaintedFace[slot] !== face) {
                lastPaintedFace[slot] = face;
                setDiceFace(slot, face, { transition: "transform 350ms cubic-bezier(.22,.9,.24,1)" });
            }
        }
    }
}

/* =========================================================
   PLAYER PANELS — one per colour, each owns that colour's die.
   Shows name, tokens home (4 dots) and what the player is doing.
========================================================= */

function updatePlayerPanels(game, players, mySlot) {
    const finishOrder = game.finishOrder || [];
    const rolling     = !!(game.rolling && game.rolling.slot);

    for (let i = 1; i <= 4; i++) {
        const slot  = "player" + i;
        const panel = document.getElementById(`panel-${slot}`);
        if (!panel) continue;

        const p        = players[slot];
        const nameEl   = document.getElementById(`panel-${slot}-name`);
        const initEl   = document.getElementById(`panel-${slot}-initial`);
        const statusEl = document.getElementById(`panel-${slot}-status`);
        const homeEl   = document.getElementById(`panel-${slot}-home`);

        const isTurn  = !!p && !game.gameOver && slot === game.currentTurn;
        const rank    = finishOrder.indexOf(slot);
        const done    = !!p && rank !== -1;
        const home    = Object.values(game.tokens?.[slot] || {}).filter(t => t.index === 56).length;

        nameEl.textContent = p ? p.name : colorLabel(slot);
        initEl.textContent = p ? (p.name.trim()[0] || "?") : colorLabel(slot)[0];
        panel.dataset.kind = (p && p.kind) || "human";

        panel.classList.toggle("pp--empty", !p);
        panel.classList.toggle("pp--turn", isTurn);
        panel.classList.toggle("pp--done", done);
        panel.classList.toggle("pp--mine", !!p && slot === mySlot);

        homeEl?.querySelectorAll("i").forEach((dot, n) => dot.classList.toggle("on", n < home));

        let status;
        if (!p)               status = "No player";
        else if (done)        status = rank === 0 ? "Finished 1st" : `Finished ${ordinal(rank + 1)}`;
        else if (isTurn)      status = rolling ? "Rolling…" : game.diceRolled ? "Moving" : (slot === mySlot ? "Your turn" : "Playing");
        else                  status = `${home}/4 home`;
        statusEl.textContent = status;
    }
}

/* =========================================================
   TOKEN ANIMATIONS — CAPTURE & HOME
========================================================= */

/* Triggered when a token is captured (sent back to home).
   Plays a flash + shake + scale-down effect on the captured token. */
function triggerCaptureAnimation(player, tokenKey) {
    const el = document.getElementById(`${player}-${tokenKey}`);
    if (!el) return;

    el.classList.add("token-captured");

    // Remove the class after animation completes so it can be re-triggered
    setTimeout(() => {
        el.classList.remove("token-captured");
    }, 700);
}

/* Triggered when a token reaches home (index 56).
   Plays a golden glow + bounce + particle burst effect. */
function triggerHomeAnimation(player, tokenKey) {
    const el = document.getElementById(`${player}-${tokenKey}`);
    if (!el) return;

    el.classList.add("token-home");

    // Spawn particle burst around the token
    spawnHomeParticles(el);

    setTimeout(() => {
        el.classList.remove("token-home");
    }, 900);
}

/* Create small golden particles that burst outward from the token */
function spawnHomeParticles(tokenEl) {
    const rect = tokenEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const count = 8;

    for (let i = 0; i < count; i++) {
        const particle = document.createElement("div");
        particle.className = "home-particle";
        document.body.appendChild(particle);

        const angle = (Math.PI * 2 * i) / count;
        const distance = 30 + Math.random() * 25;
        const tx = Math.cos(angle) * distance;
        const ty = Math.sin(angle) * distance;

        particle.style.left = centerX + "px";
        particle.style.top  = centerY + "px";
        particle.style.setProperty("--tx", tx + "px");
        particle.style.setProperty("--ty", ty + "px");

        // Clean up after animation
        setTimeout(() => {
            particle.remove();
        }, 700);
    }
}

/* =========================================================
   RENDER TOKENS
========================================================= */

let previousTokensSnapshot = null;

const HOP_STEP_MS = 380;

function computeTokenPlacements(game) {
    const placements = {};

    for (const player in game.tokens) {
        const tokenKeys = Object.keys(game.tokens[player]);
        let homeSlot   = 0;
        let finishSlot = 0;

        for (const tokenKey of tokenKeys) {
            const index = game.tokens[player][tokenKey].index;
            let cellId = null;

            if (index === -1) {
                cellId = HOME_PARK_CELLS[player]?.[homeSlot];
                homeSlot++;
            } else if (index === 56) {
                cellId = FINISH_SLOT_CELLS[player]?.[finishSlot];
                finishSlot++;
                if (!cellId) cellId = `hc-${COLOR_MAP[player]}`; // fallback
            } else {
                const coord = getAbsoluteCoord(player, index);
                cellId = coord ? `c-${coord[0]}-${coord[1]}` : null;
            }

            placements[`${player}-${tokenKey}`] = cellId;
        }
    }

    return placements;
}

function getIntermediateCellId(player, index) {
    if (index >= 0 && index <= 50) {
        const coord = getAbsoluteCoord(player, index);
        return coord ? `c-${coord[0]}-${coord[1]}` : null;
    }
    if (index >= 51 && index <= 55) {
        const coord = HOME_STRETCH[player][index - 51];
        return coord ? `c-${coord[0]}-${coord[1]}` : null;
    }
    return null;
}

/* Moves a token along `cells` (in order) as ONE continuous animation.

   Old approach: one animation per cell, each re-measuring the DOM
   (getBoundingClientRect before + after appendChild = forced layout)
   and each easing in/out, so the token visibly stopped and started on
   every square, and every square waited on an audio promise.

   Now: measure everything once, re-parent the token into its final
   cell, then run two compositor-only animations on it —
     • `translate`  : constant-speed glide through every square
     • `transform`  : the little hop arc, repeated once per square
   Neither touches layout or paint, so it stays at full frame rate on
   phones even while Firebase updates are arriving. */
function glideTokenAlong(el, cells, stepMs) {
    return new Promise((resolve) => {
        const finalCell = cells[cells.length - 1];
        if (!el || !finalCell) { resolve(); return; }

        // ---- reads (batched) ----
        const startRect = el.getBoundingClientRect();
        const centers   = cells.map(c => {
            const r = c.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const end = centers[centers.length - 1];
        const startX = startRect.left + startRect.width / 2;
        const startY = startRect.top  + startRect.height / 2;

        // ---- write ----
        finalCell.appendChild(el);

        const steps = cells.length;
        const total = steps * stepMs;
        const lift  = Math.max(10, Math.min(startRect.width * 0.9, 18));

        const path = [{ translate: `${startX - end.x}px ${startY - end.y}px`, offset: 0 }];
        centers.forEach((c, i) => {
            path.push({ translate: `${c.x - end.x}px ${c.y - end.y}px`, offset: (i + 1) / steps });
        });

        el.style.zIndex     = "40";
        el.style.willChange = "transform, translate";

        let glide, arc;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            try { glide && glide.cancel(); arc && arc.cancel(); } catch (e) { /* ignore */ }
            el.style.zIndex     = "";
            el.style.willChange = "";
            resolve();
        };

        try {
            glide = el.animate(path, { duration: total, easing: "linear" });
            arc   = el.animate([
                { transform: "translateY(0) scale(1)",                   easing: "cubic-bezier(.2,.7,.4,1)" },
                { transform: `translateY(${-lift}px) scale(1.18)`,       easing: "cubic-bezier(.6,0,.8,.4)" },
                { transform: "translateY(0) scale(1)" }
            ], { duration: stepMs, iterations: steps });
            glide.onfinish = settle;
        } catch (e) {
            settle();
            return;
        }

        // tap sound on every landing — fire and forget, never awaited
        for (let i = 1; i <= steps; i++) {
            setTimeout(() => { playTapSound(); }, i * stepMs - 40);
        }

        setTimeout(settle, total + 150); // safety net
    });
}

async function animateTokenHop(player, tokenKey, fromIndex, toIndex, finalCellId) {
    const el = document.getElementById(`${player}-${tokenKey}`);
    if (!el) return;

    // leave the stacked layout so measurements start from a clean state
    el.style.transition = "none";
    delete el.dataset.stk;

    const cells = [];
    for (let idx = fromIndex + 1; idx <= toIndex; idx++) {
        const cellId = (idx === toIndex) ? finalCellId : getIntermediateCellId(player, idx);
        const cell   = cellId ? document.getElementById(cellId) : null;
        if (cell) cells.push(cell);
    }

    if (cells.length) await glideTokenAlong(el, cells, HOP_STEP_MS);

    el.style.transition = "";
    spreadStackedTokens();
}

function resolveResultPopups(game) {
    handleResultPopups(game, latestPlayers || {});
}

function renderTokens(game) {
    const placements      = computeTokenPlacements(game);
    const prevTokens       = previousTokensSnapshot;
    const movesToAnimate   = [];
    const capturedKeys     = [];

    if (prevTokens) {
        for (const player in game.tokens) {
            for (const tokenKey in game.tokens[player]) {
                const oldIndex = prevTokens[player]?.[tokenKey]?.index;
                const newIndex = game.tokens[player][tokenKey].index;

                if (typeof oldIndex !== "number") continue;

                if (newIndex > oldIndex && (newIndex - oldIndex) <= 6) {
                    movesToAnimate.push({ player, tokenKey, from: oldIndex, to: newIndex });
                } else if (newIndex < oldIndex) {
                    capturedKeys.push(`${player}-${tokenKey}`);
                    // Trigger capture animation for tokens sent back home
                    triggerCaptureAnimation(player, tokenKey);
                }
            }
        }
    }

    previousTokensSnapshot = JSON.parse(JSON.stringify(game.tokens));

    const animatingIds = new Set(movesToAnimate.map(m => `${m.player}-${m.tokenKey}`));

    const holdCaptures = movesToAnimate.length > 0;
    const heldIds = new Set(holdCaptures ? capturedKeys : []);

    for (const key in placements) {
        if (animatingIds.has(key) || heldIds.has(key)) continue;
        const el     = document.getElementById(key);
        const cellId = placements[key];
        const cell   = cellId ? document.getElementById(cellId) : null;
        if (el && cell) cell.appendChild(el);
    }

    spreadStackedTokens();

    if (movesToAnimate.length === 0) {
        resolveResultPopups(game);
        return;
    }

    boardAnimationCount += movesToAnimate.length;
    updateDiceBoxes(latestGame || game, latestPlayers || {}, getMySlot());

    movesToAnimate.forEach(m => {
        const key = `${m.player}-${m.tokenKey}`;
        animateTokenHop(m.player, m.tokenKey, m.from, m.to, placements[key]).then(() => {
            boardAnimationCount = Math.max(0, boardAnimationCount - 1);
            if (boardAnimationCount > 0) return;

            heldIds.forEach(hKey => {
                const el     = document.getElementById(hKey);
                const cellId = placements[hKey];
                const cell   = cellId ? document.getElementById(cellId) : null;
                if (el && cell) cell.appendChild(el);
            });
            spreadStackedTokens();

            resolveResultPopups(game);

            if (latestGame) {
                updateTokenClickability(latestGame, getMySlot());
                updateDiceBoxes(latestGame, latestPlayers || {}, getMySlot());
            }
        });
    });
}

/* =========================================================
   SPREAD STACKED TOKENS
========================================================= */

function spreadStackedTokens() {
    // Group tokens by the cell they're in. Position/size for a stacked
    // token comes from CSS (`.token[data-stk]` uses translate + scale),
    // so this only flips an attribute — no layout properties are touched.
    const groups = new Map();
    document.querySelectorAll(".token").forEach(t => {
        const parent = t.parentElement;
        if (!parent) return;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(t);
    });

    groups.forEach(tokens => {
        if (tokens.length <= 1) {
            tokens.forEach(t => { if (t.dataset.stk !== undefined) delete t.dataset.stk; });
            return;
        }
        tokens.forEach((t, i) => {
            const v = String(i % 4);
            if (t.dataset.stk !== v) t.dataset.stk = v;
        });
    });
}

/* =========================================================
   TOKEN CLICK HANDLING
========================================================= */

let tokenClickDelegationBound = false;

function bindTokenClickDelegation() {
    if (tokenClickDelegationBound) return;
    const board = document.getElementById("ludo-board");
    if (!board) return;

    board.addEventListener("click", (e) => {
        const tokenEl = e.target.closest(".token");
        if (!tokenEl) return;

        const match = tokenEl.id.match(/^(player\d)-(t\d)$/);
        if (!match) return;

        const [, player, tokenKey] = match;
        handleTokenClick(player, tokenKey);
    });

    board.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const tokenEl = e.target.closest?.(".token");
        if (!tokenEl) return;
        e.preventDefault();
        tokenEl.click();
    });

    tokenClickDelegationBound = true;
}

function updateTokenClickability(game, mySlot) {
    for (let i = 1; i <= 4; i++) {
        const slot   = "player" + i;
        const tokens = game.tokens[slot];
        if (!tokens) continue;
        for (const tokenKey in tokens) {
            const el = document.getElementById(`${slot}-${tokenKey}`);
            if (el) {
                el.classList.remove("clickable");
                el.style.cursor = "default";
                el.removeAttribute("tabindex");
                el.setAttribute("aria-disabled", "true");
            }
        }
    }

    if (!mySlot) return;

    const myTokenData = game.tokens[mySlot];
    if (!myTokenData) return;

    const canInteract = !game.gameOver && game.currentTurn === mySlot && game.diceRolled && !isBoardAnimating();
    const dice = game.diceValue;

    for (const tokenKey in myTokenData) {
        const el = document.getElementById(`${mySlot}-${tokenKey}`);
        if (!el) continue;

        const index = myTokenData[tokenKey].index;
        const isLegal = canInteract && (
            (index === -1 && dice === 6) ||
            (index >= 0 && index !== 56 && index + dice <= 56)
        );

        el.classList.toggle("clickable", isLegal);
        el.style.cursor = isLegal ? "pointer" : "default";
        // keyboard users can Tab to a movable token and press Enter / Space
        if (isLegal) el.tabIndex = 0; else el.removeAttribute("tabindex");
        el.setAttribute("aria-disabled", isLegal ? "false" : "true");
    }
}

bindTokenClickDelegation();

/* =========================================================
   PLAYER SLOT UI (lobby)
========================================================= */

function updatePlayerSlots(players) {
    const mySlot = getMySlot();

    for (let i = 1; i <= 4; i++) {
        const slot     = "player" + i;
        const nameEl   = document.getElementById(slot + "-name");
        const statusEl = document.getElementById(slot + "-status");
        const slotEl   = document.getElementById(slot + "-slot");

        if (!nameEl || !statusEl) continue;

        const p = players[slot];

        if (p) {
            nameEl.textContent   = p.name;
            statusEl.textContent = "Ready";
            slotEl?.classList.replace("player-slot--empty", "player-slot--filled");
            slotEl?.setAttribute("data-kind", p.kind || "human");
            const initial = slotEl?.querySelector(".avatar__initial");
            if (initial) initial.textContent = p.name.trim()[0] || "?";
        } else {
            nameEl.textContent   = "Waiting for player";
            statusEl.textContent = "Open seat";
            slotEl?.classList.replace("player-slot--filled", "player-slot--empty");
            const initial = slotEl?.querySelector(".avatar__initial");
            if (initial) initial.textContent = "";
        }

        const hostTag = slotEl?.querySelector(".tag--host");
        const youTag  = slotEl?.querySelector(".tag--you");
        if (hostTag) hostTag.hidden = !(p && p.isHost);
        if (youTag)  youTag.hidden  = !(p && slot === mySlot);
    }
}

/* Realtime join / leave feedback in the lobby */
let previousPlayers = null;

function announcePlayerChanges(players) {
    if (previousPlayers) {
        const mySlot = getMySlot();
        for (const slot of Object.keys(COLOR_MAP)) {
            const was = previousPlayers[slot];
            const now = players[slot];
            if (!was && now && slot !== mySlot) {
                showToast(`${now.name} joined the room`, COLOR_MAP[slot]);
            } else if (was && !now && slot !== mySlot) {
                showToast(`${was.name} left the room`, "default");
            }
        }
    }
    previousPlayers = players;
}

window.handleTokenClick = handleTokenClick;

/* =========================================================
   LIVE CHAT SYSTEM — text, GIFs, replies, reactions

   Message shape at rooms/ROOM/chat/ID:
     { sender, playerName, message, timestamp,
       gif?:      { url, w, h, inline? }          // GIF / image
       replyTo?:  { id, sender, playerName, text, gif }
       reactions?: { player1: "😂", player3: "👍" } }   // one per player
========================================================= */

const chatRef = ref(db, `rooms/${roomCode}/chat`);

const CHAT_HISTORY_LIMIT   = 100;
const CHAT_RATE_LIMIT_MS   = 500;
const CHAT_MAX_LENGTH      = 200;
const CHAT_NEAR_BOTTOM_PX  = 80;

const CHAT_GIF_MAX_BYTES    = 8 * 1024 * 1024;  // biggest file we'll upload
const CHAT_GIF_INLINE_MAX   = 250 * 1024;       // fallback: embed in the message if Storage is unavailable
const CHAT_GIF_MAX_W        = 240;
const CHAT_GIF_MAX_H        = 300;
const CHAT_UPLOAD_STALL_MS  = 8000;
const REACTION_EMOJIS       = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

const chatToggleBtn   = document.getElementById("chat-toggle-btn");
const chatPanel       = document.getElementById("chat-panel");
const chatCloseBtn    = document.getElementById("chat-close-btn");
const chatMessagesEl  = document.getElementById("chat-messages");
const chatInput       = document.getElementById("chat-input");
const chatSendBtn     = document.getElementById("chat-send-btn");
const chatUnreadBadge = document.getElementById("chat-unread-badge");
const chatCharCounter = document.getElementById("chat-char-counter");
const chatBackdrop    = document.getElementById("chat-backdrop");

const chatReplyBar    = document.getElementById("chat-reply-bar");
const chatReplyName   = document.getElementById("chat-reply-name");
const chatReplyText   = document.getElementById("chat-reply-text");
const chatReplyCancel = document.getElementById("chat-reply-cancel");
const chatAttachBtn   = document.getElementById("chat-attach-btn");
const chatFileInput   = document.getElementById("chat-file-input");
const chatAttachBox   = document.getElementById("chat-attach-preview");
const chatAttachImg   = document.getElementById("chat-attach-img");
const chatAttachRemove = document.getElementById("chat-attach-remove");
const chatAttachProg  = document.getElementById("chat-attach-progress");
const chatDropEl      = document.getElementById("chat-drop");

/* On very wide screens the chat is docked beside the game (room.css),
   so it counts as "open" while a game is running. */
const dockedChatQuery = window.matchMedia("(min-width: 1600px)");
function isChatDocked() {
    return dockedChatQuery.matches && document.body.classList.contains("in-game");
}

let chatUnsubscribe   = null;
let chatIsOpen        = false;
let chatUnreadCount   = 0;
let lastMessageSentAt = 0;

const chatMessages = new Map();   // id -> { data, row, reactionsEl }
let chatReplyTarget = null;       // what the next message replies to
let pendingGif      = null;       // { file | remoteUrl, previewUrl, w, h }
let chatSending     = false;

/* ---------- media safety ---------- */

const MEDIA_HOSTS = [
    /^media\d*\.giphy\.com$/,
    /^i\.giphy\.com$/,
    /^media\d*\.tenor\.com$/,
    /^c\.tenor\.com$/,
    /^i\.imgur\.com$/,
    /^firebasestorage\.googleapis\.com$/
];

/* Only ever hand the <img> a URL we recognise — never arbitrary hosts. */
function safeMediaUrl(url) {
    if (typeof url !== "string") return null;
    if (/^data:image\/(gif|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return url;
    try {
        const u = new URL(url);
        if (u.protocol !== "https:") return null;
        return MEDIA_HOSTS.some(re => re.test(u.hostname)) ? u.href : null;
    } catch (e) {
        return null;
    }
}

/* If the whole message is just a GIF link (what phone keyboards often
   insert), turn it into a real GIF. Tenor "view" pages can't be turned
   into an image without their API, so those stay normal text. */
function gifUrlFromText(text) {
    const t = (text || "").trim();
    if (!t || /\s/.test(t)) return null;

    let u;
    try { u = new URL(t); } catch (e) { return null; }
    if (u.protocol !== "https:") return null;

    if (/^(www\.)?giphy\.com$/.test(u.hostname)) {
        const m = u.pathname.match(/^\/(?:gifs|stickers)\/(?:.*-)?([A-Za-z0-9]+)\/?$/);
        return m ? `https://media.giphy.com/media/${m[1]}/giphy.gif` : null;
    }

    if (/^firebasestorage\.googleapis\.com$/.test(u.hostname)) return null; // our own uploads only via the picker
    const safe = safeMediaUrl(u.href);
    if (!safe) return null;
    const looksLikeImage = /\.(gif|webp|png|jpe?g)$/i.test(u.pathname) || /giphy\.com$|tenor\.com$/.test(u.hostname);
    return looksLikeImage ? safe : null;
}

function readImageSize(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = src;
    });
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload  = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
    });
}

/* ---------- subscribe ---------- */

function loadRecentMessages() {
    return query(chatRef, limitToLast(CHAT_HISTORY_LIMIT));
}

let chatUnsubAdded   = null;
let chatUnsubChanged = null;

function initializeChat() {
    if (!chatMessagesEl) return;

    const chatQuery = loadRecentMessages();

    chatUnsubAdded = onChildAdded(chatQuery, (snap) => {
        addMessage(snap.val(), snap.key);
    });

    // reactions are written onto an existing message
    chatUnsubChanged = onChildChanged(chatQuery, (snap) => {
        const entry = chatMessages.get(snap.key);
        if (!entry) return;
        entry.data = snap.val() || entry.data;
        renderReactions(entry);
    });

    chatUnsubscribe = () => {
        if (chatUnsubAdded)   chatUnsubAdded();
        if (chatUnsubChanged) chatUnsubChanged();
        chatUnsubAdded = chatUnsubChanged = null;
    };
}

function destroyChat() {
    if (chatUnsubscribe) {
        chatUnsubscribe();
        chatUnsubscribe = null;
    }
}

function isChatNearBottom() {
    if (!chatMessagesEl) return true;
    const distance = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight;
    return distance < CHAT_NEAR_BOTTOM_PX;
}

function scrollChatToBottom() {
    if (!chatMessagesEl) return;
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function formatChatTime(timestamp) {
    const d = new Date(timestamp || Date.now());
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
}

/* ---------- rendering ---------- */

/* Messages are queued and flushed once per frame. Joining a busy room
   used to append up to 100 messages one at a time, each forcing a
   layout (isChatNearBottom + scroll), which is a real hitch on phones. */
let chatQueue        = [];
let chatFlushPending = false;
let chatHasRendered  = false;

function addMessage(data, id) {
    if (!chatMessagesEl || !data) return;
    chatQueue.push({ data, id });
    if (!chatFlushPending) {
        chatFlushPending = true;
        requestAnimationFrame(flushChatQueue);
    }
}

function flushChatQueue() {
    chatFlushPending = false;
    const batch = chatQueue;
    chatQueue = [];
    if (!batch.length) return;

    const mySlot        = getMySlot();
    const wasNearBottom = isChatNearBottom();
    const wasRendered   = chatHasRendered;            // false for the initial history load
    const animate       = wasRendered && batch.length <= 3;
    const frag         = document.createDocumentFragment();
    let   stick        = wasNearBottom;
    let   unread       = 0;

    for (const { data, id } of batch) {
        const row = buildChatRow(data, id, mySlot, stick || !wasRendered || data.sender === mySlot);
        if (animate) row.classList.add("chat-fade-in");
        frag.appendChild(row);

        if (data.sender === mySlot) stick = true;
        if (data.sender !== "system" && data.sender !== mySlot) unread++;
    }

    chatMessagesEl.appendChild(frag);
    chatHasRendered = true;

    if (unread && wasRendered && !chatIsOpen && !isChatDocked()) {
        chatUnreadCount += unread;
        updateChatUnreadBadge();
        playChatNotificationSound();
    }

    if (stick) scrollChatToBottom();
}

function buildChatRow(data, id, mySlot, keepPinned) {
    if (data.sender === "system") {
        const el = document.createElement("div");
        el.className = "chat-system-msg";
        el.textContent = data.message || "";
        return el;
    }

    const isMine = data.sender === mySlot;
    const hasGif = !!(data.gif && safeMediaUrl(data.gif.url));

    const row = document.createElement("div");
    row.className = `chat-bubble-row ${isMine ? "chat-bubble-row--mine" : "chat-bubble-row--theirs"}`;
    row.dataset.id = id;

    const col = document.createElement("div");
    col.className = "chat-bubble-col";

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMine ? "chat-bubble--mine" : "chat-bubble--theirs"}${hasGif ? " chat-bubble--media" : ""}`;

    if (!isMine) {
        const nameEl = document.createElement("div");
        nameEl.className = "chat-bubble__name";
        nameEl.style.color = `var(--${COLOR_MAP[data.sender] || "text"})`;
        nameEl.textContent = data.playerName || "Player";
        bubble.appendChild(nameEl);
    }

    if (data.replyTo && data.replyTo.id) bubble.appendChild(buildQuote(data.replyTo));

    if (hasGif) bubble.appendChild(buildGifImg(data.gif, keepPinned));

    if (data.message) {
        const textEl = document.createElement("div");
        textEl.className = "chat-bubble__text";
        textEl.textContent = data.message;
        bubble.appendChild(textEl);
    }

    const timeEl = document.createElement("div");
    timeEl.className = "chat-bubble__time";
    timeEl.textContent = formatChatTime(data.timestamp);
    bubble.appendChild(timeEl);

    const reactionsEl = document.createElement("div");
    reactionsEl.className = "chat-reactions";

    const actions = document.createElement("div");
    actions.className = "chat-actions";
    actions.innerHTML =
        '<button class="chat-act-btn" type="button" data-act="react" aria-label="React">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>' +
        '</button>' +
        '<button class="chat-act-btn" type="button" data-act="reply" aria-label="Reply">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/></svg>' +
        '</button>';

    const pop = document.createElement("div");
    pop.className = "chat-react-pop";
    for (const emoji of REACTION_EMOJIS) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.emoji = emoji;
        b.setAttribute("aria-label", `React ${emoji}`);
        b.textContent = emoji;
        pop.appendChild(b);
    }

    col.append(bubble, reactionsEl, actions, pop);
    row.appendChild(col);

    const entry = { data, row, reactionsEl };
    chatMessages.set(row.dataset.id, entry);
    renderReactions(entry);

    return row;
}

function buildGifImg(gif, keepPinned) {
    const img = document.createElement("img");
    img.className = "chat-gif";
    img.alt = "GIF";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.draggable = false;

    const w = Number(gif.w) || 0;
    const h = Number(gif.h) || 0;
    const reserved = w > 0 && h > 0;

    // Reserve the exact space before the image arrives so the chat
    // never jumps while GIFs load.
    if (reserved) {
        let dw = Math.min(CHAT_GIF_MAX_W, w);
        if (dw * h / w > CHAT_GIF_MAX_H) dw = Math.round(CHAT_GIF_MAX_H * w / h);
        img.style.width = dw + "px";
        img.style.aspectRatio = `${w} / ${h}`;
    } else {
        img.style.width = "200px";
        img.style.aspectRatio = "4 / 3";
    }

    img.addEventListener("load", () => {
        if (!reserved) {
            img.style.aspectRatio = "";
            const nw = img.naturalWidth, nh = img.naturalHeight;
            if (nw && nh) {
                let dw = Math.min(CHAT_GIF_MAX_W, nw);
                if (dw * nh / nw > CHAT_GIF_MAX_H) dw = Math.round(CHAT_GIF_MAX_H * nw / nh);
                img.style.width = dw + "px";
            }
        }
        if (keepPinned && isChatNearBottom()) scrollChatToBottom();
    }, { once: true });

    img.addEventListener("error", () => {
        const fallback = document.createElement("div");
        fallback.className = "chat-bubble__text";
        fallback.textContent = "GIF unavailable";
        img.replaceWith(fallback);
    }, { once: true });

    img.src = safeMediaUrl(gif.url);
    return img;
}

function buildQuote(reply) {
    const q = document.createElement("button");
    q.type = "button";
    q.className = "chat-quote";
    q.dataset.replyId = reply.id;
    q.style.setProperty("--qc", `var(--${COLOR_MAP[reply.sender] || "accent"})`);

    if (reply.gif) {
        const src = safeMediaUrl(chatMessages.get(reply.id)?.data?.gif?.url);
        if (src) {
            const thumb = document.createElement("img");
            thumb.className = "chat-quote__thumb";
            thumb.alt = "";
            thumb.decoding = "async";
            thumb.referrerPolicy = "no-referrer";
            thumb.src = src;
            q.appendChild(thumb);
        }
    }

    const body = document.createElement("span");
    body.className = "chat-quote__body";
    const name = document.createElement("span");
    name.className = "chat-quote__name";
    name.textContent = reply.playerName || "Player";
    const text = document.createElement("span");
    text.className = "chat-quote__text";
    text.textContent = reply.text || (reply.gif ? "GIF" : "");
    body.append(name, text);
    q.appendChild(body);
    return q;
}

function renderReactions(entry) {
    const el = entry.reactionsEl;
    if (!el) return;

    const mySlot = getMySlot();
    const byEmoji = new Map();
    const reactions = entry.data.reactions || {};

    for (const slot in reactions) {
        const emoji = reactions[slot];
        if (!REACTION_EMOJIS.includes(emoji)) continue;
        if (!byEmoji.has(emoji)) byEmoji.set(emoji, []);
        byEmoji.get(emoji).push(slot);
    }

    const existing = new Map(Array.from(el.children).map(c => [c.dataset.emoji, c]));

    for (const emoji of REACTION_EMOJIS) {
        const slots = byEmoji.get(emoji);
        if (!slots) continue;

        let chip = existing.get(emoji);
        if (chip) {
            existing.delete(emoji);
        } else {
            chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chat-react-chip";
            chip.dataset.emoji = emoji;
            el.appendChild(chip);
        }

        const label = slots.length > 1 ? `${emoji} ${slots.length}` : emoji;
        if (chip.dataset.label !== label) {
            chip.dataset.label = label;
            chip.replaceChildren();
            chip.append(document.createTextNode(emoji));
            if (slots.length > 1) {
                const n = document.createElement("b");
                n.textContent = String(slots.length);
                chip.appendChild(n);
            }
        }
        chip.classList.toggle("is-mine", slots.includes(mySlot));
        chip.title = slots.map(s => (latestPlayers?.[s]?.name) || colorLabel(s)).join(", ");
    }

    existing.forEach(chip => chip.remove());
}

function addSystemMessage(text) {
    addMessage({ sender: "system", message: text, timestamp: Date.now() }, `local-${Date.now()}`);
}

function pushSystemMessage(text) {
    push(chatRef, {
        sender: "system",
        message: text,
        timestamp: Date.now()
    }).catch(err => console.warn("Failed to send system chat message:", err));
}

function updateChatUnreadBadge() {
    if (!chatUnreadBadge) return;
    if (chatUnreadCount > 0) {
        chatUnreadBadge.textContent = chatUnreadCount > 9 ? "9+" : String(chatUnreadCount);
        chatUnreadBadge.style.display = "flex";
        chatToggleBtn?.classList.add("has-unread");
    } else {
        chatUnreadBadge.style.display = "none";
        chatToggleBtn?.classList.remove("has-unread");
    }
}

function playChatNotificationSound() {
    try {
        if (!audioCtx || audioCtx.state !== "running") return;
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    } catch (e) {
        // Non-critical — silently ignore
    }
}

function openChatPanel() {
    chatIsOpen = true;
    chatPanel?.classList.add("chat-panel--open");
    chatBackdrop?.classList.add("chat-backdrop--on");
    chatToggleBtn?.setAttribute("aria-expanded", "true");
    chatUnreadCount = 0;
    updateChatUnreadBadge();
    scrollChatToBottom();
    chatInput?.focus({ preventScroll: true });
}

function closeChatPanel() {
    chatIsOpen = false;
    clearChatSelection();
    chatPanel?.classList.remove("chat-panel--open");
    chatBackdrop?.classList.remove("chat-backdrop--on");
    chatToggleBtn?.setAttribute("aria-expanded", "false");
    chatToggleBtn?.focus({ preventScroll: true });
}

chatBackdrop?.addEventListener("click", closeChatPanel);

document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (confirmLeaveModal && confirmLeaveModal.style.display !== "none") { hideConfirmLeaveModal(); return; }
    if (chatMessagesEl?.querySelector(".is-selected, .is-picking")) { clearChatSelection(); return; }
    if (chatReplyTarget && document.activeElement === chatInput) { clearReply(); return; }
    if (chatIsOpen) closeChatPanel();
});

chatToggleBtn?.addEventListener("click", () => {
    chatIsOpen ? closeChatPanel() : openChatPanel();
});
chatCloseBtn?.addEventListener("click", closeChatPanel);

function updateChatCharCounter() {
    if (!chatCharCounter || !chatInput) return;
    chatCharCounter.textContent = `${chatInput.value.length}/${CHAT_MAX_LENGTH}`;
    chatCharCounter.classList.toggle("chat-char-counter--near", chatInput.value.length >= CHAT_MAX_LENGTH - 40);
}

function autoGrowChatInput() {
    if (!chatInput) return;
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 96) + "px";
}

/* ---------- selecting a message / reactions / reply ---------- */

function clearChatSelection() {
    chatMessagesEl?.querySelectorAll(".is-selected, .is-picking").forEach(r => r.classList.remove("is-selected", "is-picking"));
}

function openReactionPicker(row) {
    const entry = chatMessages.get(row.dataset.id);
    const mine  = entry?.data?.reactions?.[getMySlot()];
    const pop   = row.querySelector(".chat-react-pop");
    if (!pop) return;

    pop.querySelectorAll("button").forEach(b => b.classList.toggle("is-mine", b.dataset.emoji === mine));

    const room = row.getBoundingClientRect().top - chatMessagesEl.getBoundingClientRect().top;
    pop.classList.toggle("pick-above", room > 52);
    pop.classList.toggle("pick-below", room <= 52);

    row.classList.add("is-picking");
}

async function toggleReaction(id, emoji) {
    const mySlot = getMySlot();
    if (!mySlot) {
        showToast("Join the room to react", "error");
        return;
    }
    const entry = chatMessages.get(id);
    if (!entry || !REACTION_EMOJIS.includes(emoji)) return;

    const mineRef = ref(db, `rooms/${roomCode}/chat/${id}/reactions/${mySlot}`);
    try {
        // Firebase applies the write locally right away, so the chip
        // updates instantly through onChildChanged.
        if (entry.data.reactions?.[mySlot] === emoji) await remove(mineRef);
        else await set(mineRef, emoji);
    } catch (err) {
        console.warn("Reaction failed:", err);
        showToast("Couldn't add that reaction", "error");
    }
}

function beginReply(id) {
    const entry = chatMessages.get(id);
    if (!entry) return;
    const d = entry.data;

    const stick = isChatNearBottom();
    chatReplyTarget = {
        id,
        sender: d.sender,
        playerName: d.playerName || "Player",
        text: (d.message || "").slice(0, 80),
        gif: !!d.gif
    };

    chatReplyName.textContent = chatReplyTarget.playerName;
    chatReplyText.textContent = chatReplyTarget.text || (chatReplyTarget.gif ? "GIF" : "");
    chatReplyBar.hidden = false;
    clearChatSelection();
    chatInput?.focus({ preventScroll: true });
    if (stick) scrollChatToBottom();
}

function clearReply() {
    if (!chatReplyTarget) return;
    chatReplyTarget = null;
    chatReplyBar.hidden = true;
}

function jumpToMessage(id) {
    const entry = chatMessages.get(id);
    if (!entry || !entry.row.isConnected) {
        showToast("That message isn't available anymore");
        return;
    }
    entry.row.scrollIntoView({ block: "center", behavior: "smooth" });
    entry.row.classList.remove("chat-flash");
    void entry.row.offsetWidth;
    entry.row.classList.add("chat-flash");
    setTimeout(() => entry.row.classList.remove("chat-flash"), 950);
}

chatReplyCancel?.addEventListener("click", clearReply);

/* One delegated click handler for every message in the list. */
chatMessagesEl?.addEventListener("click", (e) => {
    const row = e.target.closest(".chat-bubble-row");
    if (!row) { clearChatSelection(); return; }
    const id = row.dataset.id;

    const quote = e.target.closest(".chat-quote");
    if (quote) { jumpToMessage(quote.dataset.replyId); return; }

    const popBtn = e.target.closest(".chat-react-pop button");
    if (popBtn) { toggleReaction(id, popBtn.dataset.emoji); clearChatSelection(); return; }

    const chip = e.target.closest(".chat-react-chip");
    if (chip) { toggleReaction(id, chip.dataset.emoji); return; }

    const act = e.target.closest("[data-act]");
    if (act) {
        if (act.dataset.act === "reply") beginReply(id);
        else if (row.classList.contains("is-picking")) row.classList.remove("is-picking");
        else openReactionPicker(row);
        return;
    }

    if (e.target.closest(".chat-bubble")) {
        const was = row.classList.contains("is-selected");
        clearChatSelection();
        if (!was) row.classList.add("is-selected");
    }
});

document.addEventListener("click", (e) => {
    if (!e.target.closest(".chat-bubble-row")) clearChatSelection();
});

/* ---------- GIFs: pick / paste / drop / link ---------- */

function setUploadProgress(p) {
    chatAttachProg?.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
}

function clearPendingGif() {
    if (pendingGif && pendingGif.file && pendingGif.previewUrl) URL.revokeObjectURL(pendingGif.previewUrl);
    pendingGif = null;
    if (chatAttachBox) { chatAttachBox.hidden = true; chatAttachBox.classList.remove("is-uploading"); }
    chatAttachImg?.removeAttribute("src");
    setUploadProgress(0);
}

async function showPendingGif(next) {
    if (chatSending) return;
    const stick = isChatNearBottom();
    clearPendingGif();
    pendingGif = next;
    chatAttachImg.src = next.previewUrl;
    chatAttachBox.hidden = false;
    chatInput?.focus({ preventScroll: true });
    if (stick) scrollChatToBottom();
}

async function stageGifFile(file) {
    if (!file) return;
    if (!getMySlot()) { showToast("Join the room to send GIFs", "error"); return; }
    if (!file.type || !file.type.startsWith("image/")) {
        showToast("Only GIFs and images can be sent", "error");
        return;
    }
    if (file.size > CHAT_GIF_MAX_BYTES) {
        showToast("That file is too big (8 MB max)", "error");
        return;
    }
    const previewUrl = URL.createObjectURL(file);
    const { w, h } = await readImageSize(previewUrl);
    await showPendingGif({ file, previewUrl, w, h });
}

async function stageRemoteGif(url) {
    if (!getMySlot()) { showToast("Join the room to send GIFs", "error"); return; }
    const { w, h } = await readImageSize(url);
    await showPendingGif({ file: null, remoteUrl: url, previewUrl: url, w, h });
}

chatAttachBtn?.addEventListener("click", () => chatFileInput?.click());
chatFileInput?.addEventListener("change", () => {
    const file = chatFileInput.files && chatFileInput.files[0];
    chatFileInput.value = "";
    stageGifFile(file);
});
chatAttachRemove?.addEventListener("click", clearPendingGif);

/* Upload to Firebase Storage with a stall guard, so a misconfigured
   bucket fails fast instead of hanging for minutes. */
async function uploadGifToStorage(file, onProgress) {
    const safeRoom = String(roomCode).replace(/[^\w-]/g, "");
    const ext = ((file.type.split("/")[1] || "gif").replace(/[^a-z0-9]/gi, "").slice(0, 5)) || "gif";
    const path = `chat-gifs/${safeRoom}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const task = uploadBytesResumable(storageRef(storage, path), file, {
        contentType: file.type,
        cacheControl: "public,max-age=31536000"
    });

    let lastTick = Date.now();
    const stallTimer = setInterval(() => {
        if (Date.now() - lastTick > CHAT_UPLOAD_STALL_MS) task.cancel();
    }, 1000);

    try {
        await new Promise((resolve, reject) => {
            task.on("state_changed",
                (s) => { lastTick = Date.now(); onProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0); },
                reject,
                resolve
            );
        });
        return await getDownloadURL(task.snapshot.ref);
    } finally {
        clearInterval(stallTimer);
    }
}

async function resolvePendingGif() {
    const g = pendingGif;
    if (g.remoteUrl) return { url: g.remoteUrl, w: g.w, h: g.h };

    chatAttachBox.classList.add("is-uploading");
    setUploadProgress(0.02);

    try {
        const url = await uploadGifToStorage(g.file, setUploadProgress);
        return { url, w: g.w, h: g.h };
    } catch (err) {
        console.warn("Storage upload failed:", err);
        if (g.file.size <= CHAT_GIF_INLINE_MAX) {
            // small enough to ride along inside the message itself
            const url = await fileToDataUrl(g.file);
            return { url, w: g.w, h: g.h, inline: true };
        }
        throw err;
    }
}

/* paste: images from the clipboard (Ctrl/Cmd+V, phone keyboards, OS GIF pickers) */
chatPanel?.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;

    let files = Array.from(cd.items || [])
        .filter(it => it.kind === "file" && it.type.startsWith("image/"))
        .map(it => it.getAsFile())
        .filter(Boolean);
    if (!files.length) files = Array.from(cd.files || []).filter(f => f.type.startsWith("image/"));

    if (files.length) {
        e.preventDefault();
        stageGifFile(files.find(f => f.type === "image/gif") || files[0]);
        return;
    }

    // some pickers paste an <img src="…"> instead of a file
    const html = cd.getData("text/html");
    const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) {
        const url = gifUrlFromText(m[1].replace(/&amp;/g, "&"));
        if (url) {
            e.preventDefault();
            stageRemoteGif(url);
        }
    }
});

/* drag & drop onto the chat */
const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
let chatDragDepth = 0;

chatPanel?.addEventListener("dragenter", (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    chatDragDepth++;
    chatDropEl?.classList.add("is-on");
});

chatPanel?.addEventListener("dragover", (e) => {
    if (dragHasFiles(e)) e.preventDefault();
});

chatPanel?.addEventListener("dragleave", (e) => {
    if (!dragHasFiles(e)) return;
    chatDragDepth = Math.max(0, chatDragDepth - 1);
    if (!chatDragDepth) chatDropEl?.classList.remove("is-on");
});

chatPanel?.addEventListener("drop", (e) => {
    chatDragDepth = 0;
    chatDropEl?.classList.remove("is-on");
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    stageGifFile(files.find(f => f.type === "image/gif") || files[0]);
});

// a stray file dropped outside the chat must not navigate away from the game
window.addEventListener("dragover", (e) => { if (dragHasFiles(e)) e.preventDefault(); });
window.addEventListener("drop",     (e) => { if (dragHasFiles(e)) e.preventDefault(); });

/* ---------- sending ---------- */

async function sendMessage() {
    if (!chatInput || chatSending) return;

    const mySlot = getMySlot();
    if (!mySlot) {
        showToast("Join the room to send messages", "error");
        return;
    }

    const raw = chatInput.value.trim();
    if (!raw && !pendingGif) return;
    if (raw.length > CHAT_MAX_LENGTH) return;

    const now = Date.now();
    if (now - lastMessageSentAt < CHAT_RATE_LIMIT_MS) return;
    lastMessageSentAt = now;

    const playerName = sessionStorage.getItem("playerName") || colorLabel(mySlot);
    const payload = { sender: mySlot, playerName, message: raw, timestamp: Date.now() };
    const reply = chatReplyTarget;

    chatSending = true;
    chatSendBtn && (chatSendBtn.disabled = true);

    try {
        if (pendingGif) {
            // keep the draft on screen until the upload really succeeds
            payload.gif = await resolvePendingGif();
        } else {
            const link = gifUrlFromText(raw);
            if (link) {
                payload.gif = { url: link, w: 0, h: 0 };
                payload.message = "";
            }
        }
        if (reply) payload.replyTo = reply;

        chatInput.value = "";
        updateChatCharCounter();
        autoGrowChatInput();
        clearPendingGif();
        clearReply();

        await push(chatRef, payload);
    } catch (err) {
        console.error("Failed to send chat message:", err);
        chatAttachBox?.classList.remove("is-uploading");
        showToast(
            pendingGif
                ? "Couldn't upload that GIF. Check that Firebase Storage is set up."
                : "Message didn't send. Check your connection.",
            "error"
        );
    } finally {
        chatSending = false;
        chatSendBtn && (chatSendBtn.disabled = false);
    }

    chatInput.focus({ preventScroll: true });
}

chatSendBtn?.addEventListener("click", sendMessage);
chatInput?.addEventListener("input", () => {
    updateChatCharCounter();
    autoGrowChatInput();
});

chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

initializeChat();