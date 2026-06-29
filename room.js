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
   BUG FIX: read playerSlot AFTER the page loads, not once at
   module-top-level before join can set it.  We use a getter
   so every call always reflects the latest sessionStorage value.
========================================================= */

function getMySlot() {
    return sessionStorage.getItem("playerSlot");
}

const isHost = sessionStorage.getItem("isHost") === "true";

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

const gameContainer   = document.getElementById("game-container");
const tokensContainer = document.getElementById("tokens-container");
const rollDiceBtn     = document.getElementById("roll-dice-btn");
const diceValueEl     = document.getElementById("dice-value");
const turnIndicator   = document.getElementById("turn-indicator");

/* Set room code in header */
document.getElementById("room-code").textContent = roomCode;

/* =========================================================
   BOARD PATH
   52-cell main track (indices 0–51)
========================================================= */

const MAIN_PATH = Array.from({ length: 52 }, (_, i) => i);

/* Safe cells — tokens here can't be captured */
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/* Home base cell IDs per player (for rendering parked tokens) */
const HOME_CELLS = {
    player1: ["home-r1", "home-r2", "home-r3", "home-r4"],
    player2: ["home-b1", "home-b2", "home-b3", "home-b4"],
    player3: ["home-g1", "home-g2", "home-g3", "home-g4"],
    player4: ["home-y1", "home-y2", "home-y3", "home-y4"]
};

/* =========================================================
   HELPERS
========================================================= */

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

function getNextPlayerSlot(players = {}) {
    if (!players.player2) return "player2";
    if (!players.player3) return "player3";
    if (!players.player4) return "player4";
    return null;
}

/*
  BUG FIX: turn order is now driven by the explicit `turnOrder` array
  stored in Firebase (written in script.js), NOT Object.keys() which
  Firebase returns in an unspecified order.
*/
function getNextTurn(turnOrder, activePlayers, current) {
    /* Only cycle through players who are actually in the game */
    const active = turnOrder.filter(slot => activePlayers[slot]);
    const index  = active.indexOf(current);
    return active[(index + 1) % active.length];
}

/* =========================================================
   COPY ROOM CODE
   BUG FIX: copy-room-btn had no listener
========================================================= */

copyRoomBtn?.addEventListener("click", async () => {
    const base    = window.location.href.split("?")[0];
    const roomUrl = base + "?code=" + roomCode;

    try {
        await navigator.clipboard.writeText(roomUrl);
    } catch {
        /* Fallback for older browsers */
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
   LEAVE ROOM
   BUG FIX: leave-room-btn had no listener at all
========================================================= */

leaveRoomBtn?.addEventListener("click", async () => {
    const mySlot = getMySlot();

    if (!mySlot) {
        window.location.href = "index.html";
        return;
    }

    try {
        /* Remove this player from the room */
        await update(roomRef, {
            [`players/${mySlot}`]: null
        });
    } catch (e) {
        console.warn("Could not remove player from room:", e);
    }

    sessionStorage.clear();
    window.location.href = "index.html";
});

/* =========================================================
   JOIN ROOM
   BUG FIX: sessionStorage.setItem now happens before joinCard
   is hidden, ensuring getMySlot() works for all subsequent calls.
========================================================= */

joinBtn?.addEventListener("click", joinRoom);

async function joinRoom() {
    const name = joinNameInput.value.trim();
    if (!name) {
        joinNameInput.placeholder = "Name is required!";
        joinNameInput.focus();
        return;
    }

    joinBtn.disabled     = true;
    joinBtn.textContent  = "Joining…";

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

        /* BUG FIX: set slot BEFORE hiding join card */
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
   BUG FIX: anyone could trigger this — now checks isHost.
   Also resets diceRolled flag properly.
========================================================= */

startGameBtn?.addEventListener("click", async () => {
    if (!isHost) return;

    const snap = await get(roomRef);
    if (!snap.exists()) return;

    const room      = snap.val();
    const players   = room.players || {};
    const turnOrder = room.turnOrder || ["player1", "player2", "player3", "player4"];
    const active    = turnOrder.filter(s => players[s]);

    /* Pick a random first turn from active players */
    const firstTurn = active[Math.floor(Math.random() * active.length)];

    await update(roomRef, {
        status:               "playing",
        "game/currentTurn":   firstTurn,
        "game/diceValue":     0,
        "game/diceRolled":    false,
        "game/winner":        null,
        "game/tokens/player1": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player2": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player3": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
        "game/tokens/player4": { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } }
    });
});

/* =========================================================
   DICE ROLL
   BUG FIX: prevent rolling again if dice already rolled this turn
========================================================= */

rollDiceBtn?.addEventListener("click", async () => {
    const mySlot = getMySlot();
    if (!mySlot) return;

    const snap = await get(roomRef);
    if (!snap.exists()) return;

    const room = snap.val();
    const game = room.game;

    if (game.currentTurn !== mySlot) return;   /* not my turn */
    if (game.diceRolled)             return;   /* already rolled */

    const dice = Math.floor(Math.random() * 6) + 1;

    await update(roomRef, {
        "game/diceValue":  dice,
        "game/diceRolled": true
    });
});

/* =========================================================
   MOVE + CAPTURE SYSTEM
   BUG FIX: use turnOrder from Firebase for getNextTurn.
   BUG FIX: reset diceRolled on turn advance.
   BUG FIX: check for win condition (all 4 tokens at index 51).
========================================================= */

async function handleTokenClick(player, tokenKey) {
    const mySlot = getMySlot();
    if (!mySlot) return;

    const snap = await get(roomRef);
    if (!snap.exists()) return;

    const room      = snap.val();
    const game      = room.game;
    const turnOrder = room.turnOrder || ["player1", "player2", "player3", "player4"];

    if (game.currentTurn !== mySlot) return;   /* not my turn */
    if (player !== mySlot)           return;   /* not my token */
    if (!game.diceRolled)            return;   /* must roll first */

    const dice  = game.diceValue;
    let   index = game.tokens[player][tokenKey].index;

    /* Leave home only on a 6 */
    if (index === -1) {
        if (dice !== 6) return;
        index = 0;
    } else {
        index += dice;
    }

    /* Can't go past the end of the track */
    if (index > MAIN_PATH.length - 1) return;

    const boardPos = MAIN_PATH[index];

    /* CAPTURE — knock off opponent tokens on non-safe cells */
    const captureUpdates = {};

    if (!SAFE_CELLS.has(boardPos)) {
        for (const p in game.tokens) {
            if (p === player) continue;
            for (const t in game.tokens[p]) {
                if (game.tokens[p][t].index === index) {
                    captureUpdates[`game/tokens/${p}/${t}/index`] = -1;
                }
            }
        }
    }

    /* Check win: all 4 tokens at final cell (index 51) */
    const myTokens     = { ...game.tokens[player], [tokenKey]: { index } };
    const allHome      = Object.values(myTokens).every(t => t.index === MAIN_PATH.length - 1);
    const nextTurn     = getNextTurn(turnOrder, room.players, mySlot);

    const moveUpdates = {
        ...captureUpdates,
        [`game/tokens/${player}/${tokenKey}/index`]: index,
        "game/diceValue":  0,
        "game/diceRolled": false,
        "game/currentTurn": allHome ? mySlot : nextTurn,
        "game/winner":      allHome ? mySlot : null
    };

    await update(roomRef, moveUpdates);

    if (allHome) {
        alert(`🎉 ${room.players[mySlot].name} wins!`);
    }
}

/* =========================================================
   REALTIME SYNC — main listener
========================================================= */

onValue(roomRef, (snap) => {
    if (!snap.exists()) return;

    const room    = snap.val();
    const players = room.players || {};
    const mySlot  = getMySlot();

    /* ── Player list ── */
    updatePlayerSlots(players);

    /* ── Join card visibility ── */
    if (mySlot) {
        /* Already in the room — hide join card */
        if (joinCard) joinCard.style.display = "none";
    } else {
        /* Check if room is full */
        const filled = Object.keys(players).length;
        if (room.maxPlayers && filled >= room.maxPlayers && joinCard) {
            joinCard.style.display = "none";
        }
    }

    /* ── Start button: only show & enable for host when room has ≥2 players ── */
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

    /* ── Waiting message ── */
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

    /* ── Switch to game view when playing ── */
    if (room.status === "playing" && room.game) {
        showGameUI(room, players);
    }
});

/* =========================================================
   SHOW GAME UI
   BUG FIX: game-container and tokens-container were never revealed
========================================================= */

function showGameUI(room, players) {
    /* Hide waiting-room UI */
    document.querySelector(".page").style.display       = "none";

    /* Show game UI */
    gameContainer.style.display   = "block";
    tokensContainer.style.display = "block";

    const game    = room.game;
    const mySlot  = getMySlot();
    const isMeTurn = game.currentTurn === mySlot;

    /* Dice & turn info */
    diceValueEl.textContent  = game.diceValue || "–";
    turnIndicator.textContent = `${PLAYER_LABELS[game.currentTurn]}'s turn${isMeTurn ? " (You!)" : ""}`;

    /* Roll button state */
    rollDiceBtn.disabled      = !isMeTurn || game.diceRolled;
    rollDiceBtn.style.opacity = rollDiceBtn.disabled ? "0.4" : "1";

    /* Render tokens */
    renderTokens(game);

    /* Wire token click handlers */
    wireTokenClicks(game, mySlot);

    /* Winner banner */
    if (game.winner) {
        const winnerName = players[game.winner]?.name || game.winner;
        turnIndicator.textContent = `🏆 ${winnerName} wins!`;
    }
}

/* =========================================================
   RENDER TOKENS
   BUG FIX: tokens at index -1 (home) were skipped — they
   disappeared from the DOM entirely when the game started.
   Now home-base tokens are placed in their home cells.
========================================================= */

function renderTokens(game) {
    for (const player in game.tokens) {
        const tokenKeys = Object.keys(game.tokens[player]);
        let   homeIndex = 0;

        for (const tokenKey of tokenKeys) {
            const el = document.getElementById(`${player}-${tokenKey}`);
            if (!el) continue;

            const index = game.tokens[player][tokenKey].index;

            if (index === -1) {
                /* Place in home base */
                const homeCellId = HOME_CELLS[player]?.[homeIndex];
                homeIndex++;
                if (homeCellId) {
                    const homeCell = document.getElementById(homeCellId);
                    if (homeCell) homeCell.appendChild(el);
                }
            } else {
                /* Place on main track */
                const cellId = MAIN_PATH[index];
                const cell   = document.getElementById("cell-" + cellId);
                if (cell) cell.appendChild(el);
            }
        }
    }
}

/* =========================================================
   WIRE TOKEN CLICKS
   BUG FIX: token elements were never made clickable.
   Only the current player's tokens get a click handler.
========================================================= */

function wireTokenClicks(game, mySlot) {
    /* Remove all existing handlers first to avoid duplicates */
    document.querySelectorAll(".token").forEach(el => {
        el.replaceWith(el.cloneNode(true));
    });

    if (!mySlot) return;

    const myTokenData = game.tokens[mySlot];
    if (!myTokenData) return;

    for (const tokenKey in myTokenData) {
        const el = document.getElementById(`${mySlot}-${tokenKey}`);
        if (!el) continue;

        el.style.cursor = "pointer";
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

/* =========================================================
   GLOBAL HOOK (kept for any inline onclick in HTML)
========================================================= */

window.handleTokenClick = handleTokenClick;