import { db } from "./firebase.js";
import {
    ref,
    get,
    update,
    onValue,
    push,
    onChildAdded,
    query,
    limitToLast
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

/* =========================================================
   ROOM INIT — read code from URL
========================================================= */

const params   = new URLSearchParams(window.location.search);
const roomCode = params.get("code");

if (!roomCode) {
    alert("Invalid Room Code");
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
const startGameBtn  = document.getElementById("start-game-btn");
const leaveRoomBtn  = document.getElementById("leave-room-btn");
const copyLinkBtn   = document.getElementById("copy-link-btn");
const copyCodeBtn   = document.getElementById("copy-code-btn");
const waitingMsg    = document.getElementById("waiting-message");

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

/* Set room code in header */
document.getElementById("room-code").textContent = roomCode;

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
        if (audioCtx.state === "suspended") {
            try { await audioCtx.resume(); } catch (e) { /* ignore — fallback below still works */ }
        }
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

async function playTapSound() {
    if (audioCtx && tapSoundBuffer) {
        if (audioCtx.state === "suspended") {
            try { await audioCtx.resume(); } catch (e) { /* ignore — fallback below still works */ }
        }
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

function hideResultModal() {
    if (resultModal) resultModal.style.display = "none";
}

/* Popup shown when a player finishes but others are still playing.
   Only a "Continue Game" button — dismisses locally, game keeps going. */
function showInterimModal(slot, rank, players) {
    if (!resultModal) return;
    const name = players[slot]?.name || PLAYER_LABELS[slot];

    modalIconEl.textContent  = rank === 1 ? "🏆" : "🎉";
    modalTitleEl.textContent = rank === 1
        ? `${name} Won!`
        : `${name} finished ${ordinal(rank)}!`;

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
        modalIconEl.textContent      = "🏆";
        modalTitleEl.textContent     = `${name} Won!`;
        modalRankingEl.style.display = "none";
        modalRankingEl.innerHTML      = "";
    } else {
        modalIconEl.textContent      = "🏁";
        modalTitleEl.textContent     = "Game Over!";
        modalRankingEl.style.display = "flex";
        modalRankingEl.innerHTML      = finalOrder.map((slot, i) => {
            const name  = players[slot]?.name || PLAYER_LABELS[slot];
            const color = COLOR_MAP[slot];
            return `
                <div class="rank-row">
                    <span class="rank-number">${i + 1}</span>
                    <span class="legend-color legend-color--${color}"></span>
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

async function leaveRoom() {
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

leaveRoomBtn?.addEventListener("click", leaveRoom);
leaveGameBtnBottom?.addEventListener("click", leaveRoom);  // Leave Game button below the board
modalLeaveBtn?.addEventListener("click", leaveRoom);
modalContinueBtn?.addEventListener("click", hideResultModal);

/* =========================================================
   COPY ROOM LINK / CODE
========================================================= */

async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const tmp = document.createElement("input");
        tmp.value = text;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        document.body.removeChild(tmp);
    }
}

function flashCopied(btn, originalText) {
    if (!btn) return;
    btn.textContent = "✓ Copied!";
    setTimeout(() => { btn.textContent = originalText; }, 2500);
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

async function joinRoom() {
    const name = joinNameInput.value.trim();
    if (!name) {
        joinNameInput.placeholder = "Name is required!";
        joinNameInput.focus();
        return;
    }

    joinBtn.disabled    = true;
    joinBtn.textContent = "Joining…";

    try {
        const snap = await get(roomRef);
        if (!snap.exists()) {
            alert("Room not found.");
            window.location.href = "index.html";
            return;
        }

        const room = snap.val();

        if (room.status === "playing") {
            alert("Game already in progress.");
            window.location.href = "index.html";
            return;
        }

        const slot = getNextPlayerSlot(room.players, room.maxPlayers);

        if (!slot) {
            alert("Room is full.");
            window.location.href = "index.html";
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
        alert("Failed to join room.");
        joinBtn.disabled    = false;
        joinBtn.textContent = "Join Game";
    }
}

/* =========================================================
   START GAME
========================================================= */

startGameBtn?.addEventListener("click", async () => {
    if (!isHost) return;

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

    update(roomRef, {
        "game/rolling":    null,
        "game/diceValue":  dice,
        "game/diceRolled": true
    }).catch(err => console.error("Failed to sync roll result:", err));
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
                    }
                }
            }
        }
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

    const moveUpdates = {
        ...captureUpdates,
        [`game/tokens/${player}/${tokenKey}/index`]: index,
        "game/diceValue":     0,
        "game/diceRolled":    false,
        "game/currentTurn":   nextTurn,
        "game/finishOrder":   finishOrder,
        "game/gameOver":      gameOver,
        "game/finalOrder":    gameOver ? finalOrder : null,
        "game/winner":        gameOver ? finalOrder[0] : null,
        "game/turnStartedAt": gameOver ? null : Date.now()
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

/* TWO-PLAYER MODE
   A room created for exactly 2 players (room.maxPlayers === 2) plays
   Red vs Yellow — player1 (red, top-left) and player4 (yellow,
   bottom-right), which are diagonally opposite corners on the board. */
let mode2p = false;

function colorLabel(slot) {
    return PLAYER_LABELS[slot];
}

let timeoutHandledForTurn = null; // the turnStartedAt value we've already auto-acted on

function updateTimerBadges(currentTurn, remaining, gameOver) {
    for (const slot of ["player1", "player2", "player3", "player4"]) {
        const badge = diceTimers[slot];
        if (!badge) continue;

        const isActive = !gameOver && slot === currentTurn;
        badge.classList.toggle("dice-timer--active", isActive);

        if (isActive) {
            badge.textContent = String(Math.max(0, remaining));
            badge.classList.toggle("dice-timer--warning", remaining <= 10);
        } else {
            badge.classList.remove("dice-timer--warning");
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

onValue(roomRef, (snap) => {
    if (!snap.exists()) return;

    const room    = snap.val();
    const players = room.players || {};
    const mySlot  = getMySlot();

    latestRoom    = room;
    latestGame    = room.game || null;
    latestPlayers = players;

    // Keep the two-player mode flag in sync with the room's
    // configured capacity, and reflect it on <body> so room.css's
    // `body.mode-2p` override can hide the unused player2/player3
    // seats everywhere at once.
    mode2p = room.maxPlayers === 2;
    document.body.classList.toggle("mode-2p", mode2p);

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

    if (waitingMsg) {
        const count = Object.keys(players).length;
        const max   = room.maxPlayers || 4;
        if (room.status === "playing") {
            waitingMsg.style.display = "none";
        } else {
            waitingMsg.textContent = count >= max
                ? "All players joined! Host can start."
                : `Waiting for players… (${count}/${max})`;
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
    gameContainer.style.display = "block";

    const game     = room.game;
    const mySlot   = getMySlot();
    const isMeTurn = game.currentTurn === mySlot;

    if (game.gameOver) {
        turnIndicator.textContent = "🏁 Game Over!";
    } else {
        turnIndicator.textContent = `${colorLabel(game.currentTurn)}'s turn${isMeTurn ? " (You!)" : ""}`;
    }

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

    updatePlayerLegend(players, game.currentTurn, game.winner);
    updateHomeLabels(players);
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
   PLAYER LEGEND
========================================================= */

function updatePlayerLegend(players, currentTurn, winner) {
    for (let i = 1; i <= 4; i++) {
        const slot     = "player" + i;
        const itemEl   = document.getElementById(`legend-${slot}`);
        const nameEl   = document.getElementById(`legend-${slot}-name`);
        if (!itemEl || !nameEl) continue;

        const p = players[slot];

        nameEl.textContent = p ? p.name : `${colorLabel(slot)} (empty)`;
        itemEl.classList.toggle("legend-item--empty", !p);
        itemEl.classList.toggle("legend-item--turn", !!p && slot === currentTurn && !winner);
        itemEl.classList.toggle("legend-item--winner", !!p && slot === winner);
    }
}

/* =========================================================
   HOME LABELS
========================================================= */

function updateHomeLabels(players) {
    for (let i = 1; i <= 4; i++) {
        const slot  = "player" + i;
        const color = COLOR_MAP[slot];
        const el    = document.getElementById(`home-name-${color}`);
        if (!el) continue;

        const p = players[slot];
        el.textContent = p ? p.name : "";
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

function hopTokenToCell(el, destCell, durationMs) {
    return new Promise((resolve) => {
        if (!el || !destCell) { resolve(); return; }

        const startRect = el.getBoundingClientRect();
        destCell.appendChild(el);
        const endRect = el.getBoundingClientRect();

        const dx = startRect.left - endRect.left;
        const dy = startRect.top  - endRect.top;

        if (!dx && !dy) { resolve(); return; }

        const hopHeight = Math.max(10, Math.min(startRect.width * 0.9, 18));
        el.style.zIndex = "40";

        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            el.style.transform = "";
            el.style.zIndex    = "";
            resolve();
        };

        try {
            const anim = el.animate([
                { transform: `translate(${dx}px, ${dy}px) scale(1)`,                             offset: 0   },
                { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - hopHeight}px) scale(1.18)`,  offset: 0.5 },
                { transform: "translate(0px, 0px) scale(1)",                                      offset: 1   }
            ], { duration: durationMs, easing: "ease-in-out", fill: "forwards" });
            anim.onfinish = settle;
        } catch (e) {
            settle();
            return;
        }

        setTimeout(settle, durationMs + 100);
    });
}

async function animateTokenHop(player, tokenKey, fromIndex, toIndex, finalCellId) {
    const el = document.getElementById(`${player}-${tokenKey}`);
    if (!el) return;

    el.style.position = "";
    el.style.top       = "";
    el.style.left      = "";
    el.style.width     = "";
    el.style.height    = "";

    const steps = toIndex - fromIndex;

    for (let i = 1; i <= steps; i++) {
        const intermediateIndex = fromIndex + i;
        const cellId = (intermediateIndex === toIndex)
            ? finalCellId
            : getIntermediateCellId(player, intermediateIndex);

        const cell = cellId ? document.getElementById(cellId) : null;
        if (!cell) continue;

        await playTapSound();
        await hopTokenToCell(el, cell, HOP_STEP_MS);
    }

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
    const parents = new Set();
    document.querySelectorAll(".token").forEach(t => {
        if (t.parentElement) parents.add(t.parentElement);
    });

    const corners = [
        { top: "6%",  left: "6%"  },
        { top: "6%",  left: "50%" },
        { top: "50%", left: "6%"  },
        { top: "50%", left: "50%" }
    ];

    parents.forEach(parent => {
        const tokens = Array.from(parent.children).filter(c => c.classList.contains("token"));

        if (tokens.length <= 1) {
            tokens.forEach(t => {
                t.style.position = "";
                t.style.top      = "";
                t.style.left     = "";
                t.style.width    = "";
                t.style.height   = "";
                t.style.zIndex   = "";
            });
            return;
        }

        parent.style.position = parent.style.position || "relative";

        tokens.forEach((t, i) => {
            const corner = corners[i % corners.length];
            t.style.position = "absolute";
            t.style.top      = corner.top;
            t.style.left     = corner.left;
            t.style.width    = "44%";
            t.style.height   = "44%";
            t.style.zIndex   = String(10 + i);
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
    }
}

bindTokenClickDelegation();

/* =========================================================
   PLAYER SLOT UI
========================================================= */

function updatePlayerSlots(players) {
    for (let i = 1; i <= 4; i++) {
        const slot     = "player" + i;
        const nameEl   = document.getElementById(slot + "-name");
        const statusEl = document.getElementById(slot + "-status");
        const slotEl   = document.getElementById(slot + "-slot");

        if (!nameEl || !statusEl) continue;

        const p = players[slot];

        if (p) {
            nameEl.textContent   = p.name + (p.isHost ? " 👑" : "");
            statusEl.textContent = "Ready";
            slotEl?.classList.replace("player-slot--empty", "player-slot--filled");
        } else {
            nameEl.textContent   = "Waiting…";
            statusEl.textContent = "Empty";
            slotEl?.classList.replace("player-slot--filled", "player-slot--empty");
        }
    }
}

window.handleTokenClick = handleTokenClick;

/* =========================================================
   LIVE TEXT CHAT SYSTEM
========================================================= */

const chatRef = ref(db, `rooms/${roomCode}/chat`);

const CHAT_HISTORY_LIMIT   = 100;
const CHAT_RATE_LIMIT_MS   = 500;
const CHAT_MAX_LENGTH      = 200;
const CHAT_NEAR_BOTTOM_PX  = 80;

const chatToggleBtn   = document.getElementById("chat-toggle-btn");
const chatPanel       = document.getElementById("chat-panel");
const chatCloseBtn    = document.getElementById("chat-close-btn");
const chatMessagesEl  = document.getElementById("chat-messages");
const chatInput       = document.getElementById("chat-input");
const chatSendBtn     = document.getElementById("chat-send-btn");
const chatUnreadBadge = document.getElementById("chat-unread-badge");
const chatCharCounter = document.getElementById("chat-char-counter");

let chatUnsubscribe   = null;
let chatIsOpen        = false;
let chatUnreadCount   = 0;
let lastMessageSentAt = 0;

function loadRecentMessages() {
    return query(chatRef, limitToLast(CHAT_HISTORY_LIMIT));
}

function initializeChat() {
    if (!chatMessagesEl) return;

    const chatQuery = loadRecentMessages();

    chatUnsubscribe = onChildAdded(chatQuery, (snap) => {
        addMessage(snap.val(), snap.key);
    });
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

function addMessage(data, id) {
    if (!chatMessagesEl || !data) return;

    const wasNearBottom = isChatNearBottom();
    const mySlot = getMySlot();

    let bubble;

    if (data.sender === "system") {
        bubble = document.createElement("div");
        bubble.className = "chat-system-msg";
        bubble.textContent = data.message;
    } else {
        const isMine = data.sender === mySlot;

        bubble = document.createElement("div");
        bubble.className = `chat-bubble-row ${isMine ? "chat-bubble-row--mine" : "chat-bubble-row--theirs"}`;

        const bubbleInner = document.createElement("div");
        bubbleInner.className = `chat-bubble ${isMine ? "chat-bubble--mine" : "chat-bubble--theirs"}`;

        if (!isMine) {
            const nameEl = document.createElement("div");
            nameEl.className = "chat-bubble__name";
            nameEl.style.color = `var(--${COLOR_MAP[data.sender] || "text"})`;
            nameEl.textContent = data.playerName || "Player";
            bubbleInner.appendChild(nameEl);
        }

        const textEl = document.createElement("div");
        textEl.className = "chat-bubble__text";
        textEl.textContent = data.message;

        const timeEl = document.createElement("div");
        timeEl.className = "chat-bubble__time";
        timeEl.textContent = formatChatTime(data.timestamp);

        bubbleInner.appendChild(textEl);
        bubbleInner.appendChild(timeEl);
        bubble.appendChild(bubbleInner);
    }

    bubble.classList.add("chat-fade-in");
    chatMessagesEl.appendChild(bubble);

    if (data.sender !== "system" && data.sender !== mySlot && !chatIsOpen) {
        chatUnreadCount++;
        updateChatUnreadBadge();
        playChatNotificationSound();
    }

    if (wasNearBottom || data.sender === mySlot) {
        scrollChatToBottom();
    }
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
    } else {
        chatUnreadBadge.style.display = "none";
    }
}

function playChatNotificationSound() {
    try {
        if (!audioCtx || audioCtx.state === "suspended") return;
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
    chatUnreadCount = 0;
    updateChatUnreadBadge();
    scrollChatToBottom();
    chatInput?.focus();
}

function closeChatPanel() {
    chatIsOpen = false;
    chatPanel?.classList.remove("chat-panel--open");
}

chatToggleBtn?.addEventListener("click", () => {
    chatIsOpen ? closeChatPanel() : openChatPanel();
});
chatCloseBtn?.addEventListener("click", closeChatPanel);

function updateChatCharCounter() {
    if (!chatCharCounter || !chatInput) return;
    chatCharCounter.textContent = `${chatInput.value.length}/${CHAT_MAX_LENGTH}`;
}

function autoGrowChatInput() {
    if (!chatInput) return;
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 96) + "px";
}

async function sendMessage() {
    if (!chatInput) return;

    const mySlot = getMySlot();
    if (!mySlot) return;

    const raw = chatInput.value.trim();
    if (!raw) return;
    if (raw.length > CHAT_MAX_LENGTH) return;

    const now = Date.now();
    if (now - lastMessageSentAt < CHAT_RATE_LIMIT_MS) return;
    lastMessageSentAt = now;

    const playerName = sessionStorage.getItem("playerName") || colorLabel(mySlot);

    chatInput.value = "";
    updateChatCharCounter();
    autoGrowChatInput();

    try {
        await push(chatRef, {
            sender: mySlot,
            playerName,
            message: raw,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error("Failed to send chat message:", err);
    }

    chatInput.focus();
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