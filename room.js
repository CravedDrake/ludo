import { db } from "./firebase.js";
import {
    ref,
    get,
    update,
    onValue
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

const ROLL_DURATION = 1000; // ms — how long the synced dice-spin animation runs
const TURN_SECONDS  = 45;   // per-turn countdown shown on each color's timer badge
const STALE_ROLL_MS = ROLL_DURATION + 4000; // safety window before any client can clear a stuck roll

/* =========================================================
   UI ELEMENTS
========================================================= */

const joinCard      = document.getElementById("join-card");
const joinNameInput = document.getElementById("join-name");
const joinBtn       = document.getElementById("join-btn");
const startGameBtn  = document.getElementById("start-game-btn");
const leaveRoomBtn  = document.getElementById("leave-room-btn");
const copyRoomBtn   = document.getElementById("copy-room-btn");
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
const diceImgs = {
    player1: document.getElementById("dice-img-player1"),
    player2: document.getElementById("dice-img-player2"),
    player3: document.getElementById("dice-img-player3"),
    player4: document.getElementById("dice-img-player4"),
};

/* NEW: per-color turn-timer badges (45s countdown) */
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

function playDiceSound() {
    if (audioCtx && diceSoundBuffer) {
        // Mobile browsers suspend the AudioContext until a user gesture;
        // resume() here (called synchronously from the click handler) satisfies that.
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
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

function getNextPlayerSlot(players = {}) {
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
   LEAVE ROOM (shared by the sidebar button and the popup button)
========================================================= */

async function leaveRoom() {
    const mySlot = getMySlot();

    if (mySlot) {
        try {
            await update(roomRef, { [`players/${mySlot}`]: null });
        } catch (e) {
            console.warn("Could not remove player from room:", e);
        }
    }

    sessionStorage.clear();
    window.location.href = "index.html";
}

leaveRoomBtn?.addEventListener("click", leaveRoom);
modalLeaveBtn?.addEventListener("click", leaveRoom);
modalContinueBtn?.addEventListener("click", hideResultModal);

/* =========================================================
   COPY ROOM CODE
========================================================= */

copyRoomBtn?.addEventListener("click", async () => {
    const base    = window.location.href.split("?")[0];
    const roomUrl = base + "?code=" + roomCode;

    try {
        await navigator.clipboard.writeText(roomUrl);
    } catch {
        const tmp = document.createElement("input");
        tmp.value = roomUrl;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        document.body.removeChild(tmp);
    }

    copyRoomBtn.textContent = "✓ Copied!";
    setTimeout(() => { copyRoomBtn.textContent = "Copy"; }, 2500);
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

        const slot = getNextPlayerSlot(room.players);

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
        "game/tokens/player1": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player2": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player3": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player4": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } }
    });
});

/* =========================================================
   NEW: SYNCED DICE ROLL SYSTEM
   Rolling is now a piece of shared state (`game/rolling`) instead
   of a purely local animation. Whoever clicks their own dice box
   writes `{ slot, startedAt }` to the room; EVERY connected client
   (including the roller) reacts to that write by spinning the same
   dice box for the same ~1s window, driven off the same `startedAt`
   timestamp so they all end together. Only the roller's own client
   then computes the actual result and writes it back, clearing
   `game/rolling`. This is what makes the roll — and its result —
   show up in real time on every device instead of just the
   roller's.
========================================================= */

let currentAnimatingSlot = null; // slot currently showing the synced roll animation locally
let diceAnimInterval      = null; // face-cycling interval for the active animation
let animationStopTimeout  = null; // timeout that ends the active animation

function startDiceAnimation(slot, startedAt) {
    const box = diceBoxes[slot];
    const img = diceImgs[slot];
    if (!box || !img) return;

    currentAnimatingSlot = slot;
    box.classList.add("dice-rolling");
    playDiceSound();

    diceAnimInterval = setInterval(() => {
        const randomFace = Math.floor(Math.random() * 6) + 1;
        img.src = `images/dice/${randomFace}.png`;
    }, 70 + Math.random() * 20);

    const elapsed   = Date.now() - startedAt;
    const remaining = Math.max(0, ROLL_DURATION - elapsed);

    animationStopTimeout = setTimeout(() => {
        finishDiceAnimation(slot);
    }, remaining);
}

function stopDiceAnimation(slot) {
    const box = diceBoxes[slot];
    if (box) box.classList.remove("dice-rolling");
    if (diceAnimInterval)     { clearInterval(diceAnimInterval); diceAnimInterval = null; }
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

/* Keeps every client's local animation in sync with `game.rolling`.
   Called on every realtime update. */
function syncDiceRollingAnimation(game) {
    const rolling = game.rolling;

    if (!rolling || !rolling.slot) {
        if (currentAnimatingSlot) stopDiceAnimation(currentAnimatingSlot);
        return;
    }

    if (rolling.slot === currentAnimatingSlot) return; // already animating this exact roll

    if (currentAnimatingSlot) stopDiceAnimation(currentAnimatingSlot);
    startDiceAnimation(rolling.slot, rolling.startedAt);
}

/* Called ONLY by the client whose color just finished rolling.
   Computes the real dice value, checks for a legal move, and writes
   the final result (or an auto-skip if nothing can move).

   NEW: uses the locally cached `latestRoom`/`latestGame` (kept fresh
   by the onValue listener) instead of doing a fresh get(roomRef)
   read here. That read-then-write pattern meant every single roll
   paid for TWO full network round-trips back to Firebase before
   anything visually resolved — fine on a fast/low-latency laptop
   connection, but very noticeable extra delay on phone wifi/cellular.
   Since the listener already has the up-to-date state, we can skip
   straight to the write. */
async function finalizeRoll(mySlot) {
    const room = latestRoom;
    const game = latestGame;
    const turnOrder = (room && room.turnOrder) || ["player1", "player2", "player3", "player4"];

    // Safety: only finalize if this roll is still genuinely ours
    if (!game || !game.rolling || game.rolling.slot !== mySlot) return;
    if (game.currentTurn !== mySlot) {
        await update(roomRef, { "game/rolling": null });
        return;
    }

    const dice = Math.floor(Math.random() * 6) + 1;
    const img  = diceImgs[mySlot];
    if (img) img.src = `images/dice/${dice}.png`;

    if (!hasLegalMove(dice, game.tokens[mySlot])) {
        const finishOrder = game.finishOrder || [];
        const nextTurn    = getNextTurn(turnOrder, room.players, mySlot, finishOrder);
        await update(roomRef, {
            "game/rolling":       null,
            "game/diceValue":     dice,
            "game/diceRolled":    false,
            "game/currentTurn":   nextTurn,
            "game/turnStartedAt": Date.now()
        });
        return;
    }

    await update(roomRef, {
        "game/rolling":    null,
        "game/diceValue":  dice,
        "game/diceRolled": true
    });
}

/* Click handler shared by all 4 dice boxes. Only fires for real if
   the clicked box belongs to the LOCAL player's own color, it's
   currently that color's turn, and no roll is already in progress. */
async function handleDiceClick(slot) {
    const mySlot = getMySlot();
    if (!mySlot) return;
    if (slot !== mySlot) return;
    if (!latestGame) return;

    const game = latestGame;
    const room = latestRoom;
    if (!room) return;

    if (game.currentTurn !== mySlot)          return;
    if (game.diceRolled)                      return;
    if (game.gameOver)                        return;
    if (game.rolling && game.rolling.slot)    return; // a roll is already in flight

    try {
        await update(roomRef, {
            "game/rolling": { slot: mySlot, startedAt: Date.now() }
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

    // NEW: use cached state instead of a fresh get(roomRef) round-trip —
    // see the comment on finalizeRoll() above for why.
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

    const grantsExtraTurn = dice === 6 || Object.keys(captureUpdates).length > 0;

    let nextTurn;
    if (gameOver) {
        nextTurn = null;
    } else if (allHome) {
        /* This player just finished — hand off to the next player
           still in the game, ignore any "extra turn" they'd have earned. */
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
}

/* =========================================================
   NEW: 45-SECOND TURN TIMER
   `game/turnStartedAt` marks when the CURRENT turn began. Every
   client ticks a local interval that reads the elapsed time off
   that shared timestamp, so all devices count down in sync without
   needing per-tick database writes. Only the client whose color is
   actually up acts on expiry (forfeiting the roll, or auto-playing
   the first legal token if the dice was already rolled), so the
   timeout is never double-applied.
========================================================= */

let latestRoom   = null;
let latestGame   = null;
let latestPlayers = null;

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

async function handleTurnTimeout(mySlot) {
    // NEW: use cached state instead of a fresh get(roomRef) round-trip.
    const room = latestRoom;
    const game = latestGame;
    if (!room || !game || game.gameOver) return;
    if (game.currentTurn !== mySlot) return;
    if (game.rolling && game.rolling.slot) return; // mid-roll — let it resolve first

    const turnOrder   = room.turnOrder || ["player1", "player2", "player3", "player4"];
    const finishOrder = game.finishOrder || [];

    if (!game.diceRolled) {
        // Ran out of time before even rolling — forfeit the turn.
        const nextTurn = getNextTurn(turnOrder, room.players, mySlot, finishOrder);
        await update(roomRef, {
            "game/diceValue":     0,
            "game/diceRolled":    false,
            "game/currentTurn":   nextTurn,
            "game/turnStartedAt": Date.now()
        });
        return;
    }

    // Dice was rolled but no move was made in time — auto-play the first legal token.
    const dice     = game.diceValue;
    const tokens   = game.tokens[mySlot];
    const tokenKey = findFirstLegalToken(dice, tokens);

    if (tokenKey) {
        await performMove(mySlot, tokenKey, room);
    } else {
        const nextTurn = getNextTurn(turnOrder, room.players, mySlot, finishOrder);
        await update(roomRef, {
            "game/diceValue":     0,
            "game/diceRolled":    false,
            "game/currentTurn":   nextTurn,
            "game/turnStartedAt": Date.now()
        });
    }
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

    const elapsed   = (Date.now() - turnStartedAt) / 1000;
    const remaining = Math.ceil(TURN_SECONDS - elapsed);

    updateTimerBadges(game.currentTurn, remaining, false);

    const mySlot = getMySlot();
    if (
        remaining <= 0 &&
        mySlot === game.currentTurn &&
        timeoutHandledForTurn !== turnStartedAt
    ) {
        timeoutHandledForTurn = turnStartedAt;
        handleTurnTimeout(mySlot);
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
        handleResultPopups(room.game, players);
    }
});

/* =========================================================
   SHOW GAME UI
========================================================= */

function showGameUI(room, players) {
    document.querySelector(".page").style.display = "none";
    gameContainer.style.display = "block";

    const game     = room.game;
    const mySlot   = getMySlot();
    const isMeTurn = game.currentTurn === mySlot;

    if (game.gameOver) {
        turnIndicator.textContent = "🏁 Game Over!";
    } else {
        turnIndicator.textContent = `${PLAYER_LABELS[game.currentTurn]}'s turn${isMeTurn ? " (You!)" : ""}`;
    }

    updateDiceBoxes(game, players, mySlot);
    renderTokens(game);
    wireTokenClicks(game, mySlot);
    updatePlayerLegend(players, game.currentTurn, game.winner);
    updateHomeLabels(players);
}

/* =========================================================
   UPDATE DICE BOXES
   Runs on every realtime update. Shows/hides + dims/glows each of
   the 4 per-color dice boxes based on whose turn it is, whether a
   seat is filled, and whether it's the local player's own color.
   Skips overwriting the dice face while a synced roll animation is
   actively spinning that box (syncDiceRollingAnimation owns it then).
========================================================= */

function updateDiceBoxes(game, players, mySlot) {
    for (const slot of ["player1", "player2", "player3", "player4"]) {
        const box = diceBoxes[slot];
        const img = diceImgs[slot];
        if (!box || !img) continue;

        const playerExists = !!players[slot];
        box.classList.toggle("dice-box--empty", !playerExists);

        if (!playerExists) {
            box.classList.remove("dice-active", "dice-idle", "dice-box--mine");
            continue;
        }

        const isThisTurn = !game.gameOver && slot === game.currentTurn;

        box.classList.toggle("dice-active", isThisTurn);
        box.classList.toggle("dice-idle", !isThisTurn);
        box.classList.toggle("dice-box--mine", slot === mySlot);

        // Don't stomp the face while a synced rolling animation owns this box
        if (currentAnimatingSlot === slot) continue;

        if (isThisTurn) {
            img.src = game.diceValue ? `images/dice/${game.diceValue}.png` : "images/dice/1.png";
        }
    }
}

/* =========================================================
   PLAYER LEGEND — color swatch beside each player's name
========================================================= */

function updatePlayerLegend(players, currentTurn, winner) {
    for (let i = 1; i <= 4; i++) {
        const slot     = "player" + i;
        const itemEl   = document.getElementById(`legend-${slot}`);
        const nameEl   = document.getElementById(`legend-${slot}-name`);
        if (!itemEl || !nameEl) continue;

        const p = players[slot];

        nameEl.textContent = p ? p.name : `${PLAYER_LABELS[slot]} (empty)`;
        itemEl.classList.toggle("legend-item--empty", !p);
        itemEl.classList.toggle("legend-item--turn", !!p && slot === currentTurn && !winner);
        itemEl.classList.toggle("legend-item--winner", !!p && slot === winner);
    }
}

/* =========================================================
   HOME LABELS — player name shown right on the board, beside
   that color's own corner/home circle (label-red, label-blue,
   label-green, label-yellow in room.html/room.css).
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
   RENDER TOKENS — placed onto the real c-ROW-COL grid cells
========================================================= */

function renderTokens(game) {
    for (const player in game.tokens) {
        const tokenKeys = Object.keys(game.tokens[player]);
        let   homeSlot   = 0; // parked-at-home slot index (index === -1)
        let   finishSlot = 0; // individual finish-slot index (index === 56)

        for (const tokenKey of tokenKeys) {
            const el = document.getElementById(`${player}-${tokenKey}`);
            if (!el) continue;

            const index = game.tokens[player][tokenKey].index;

            if (index === -1) {
                const cellId = HOME_PARK_CELLS[player]?.[homeSlot];
                homeSlot++;
                const cell = cellId ? document.getElementById(cellId) : null;
                if (cell) cell.appendChild(el);
            } else if (index === 56) {
                /* Finished tokens go to their own individual outer-ring
                   slot cell instead of piling into the shared home circle. */
                const cellId = FINISH_SLOT_CELLS[player]?.[finishSlot];
                finishSlot++;
                const cell = cellId ? document.getElementById(cellId) : null;
                if (cell) {
                    cell.appendChild(el);
                } else {
                    // Fallback, in case more than 4 slots were ever needed
                    const homeCircle = document.getElementById(`hc-${COLOR_MAP[player]}`);
                    if (homeCircle) homeCircle.appendChild(el);
                }
            } else {
                const coord = getAbsoluteCoord(player, index);
                const cell  = getCellEl(coord);
                if (cell) cell.appendChild(el);
            }
        }
    }

    spreadStackedTokens();
}

/* =========================================================
   SPREAD STACKED TOKENS
   When 2+ tokens (same or different colors) land on the same
   cell — very common on safe cells — they were being appended
   on top of each other. The topmost one soaked up every click
   and the token(s) underneath became permanently unclickable.
   This nudges each token in a shared cell into its own corner
   so every token keeps its own clickable hit area.
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
   WIRE TOKEN CLICKS
   NEW: also toggles the "clickable" class (pulsing highlight,
   already defined in room.css) on exactly the tokens that have a
   legal move right now, so it's obvious at a glance what you can
   move after rolling.
========================================================= */

function wireTokenClicks(game, mySlot) {
    document.querySelectorAll(".token").forEach(el => {
        el.replaceWith(el.cloneNode(true));
    });

    // Clear stale highlighting on everyone's tokens first
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

    const canInteract = !game.gameOver && game.currentTurn === mySlot && game.diceRolled;
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
        el.addEventListener("click", () => handleTokenClick(mySlot, tokenKey));
    }
}

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