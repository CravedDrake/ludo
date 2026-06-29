import { db } from "./firebase.js";
import {
    ref,
    set,
    get
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

console.log("Firebase Connected!");

/* =========================================================
   CONSTANTS
========================================================= */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/* =========================================================
   DOM
========================================================= */

const playerNameInput = document.getElementById("player-name");
const nameError       = document.getElementById("name-error");
const countError      = document.getElementById("count-error");
const countBtns       = document.querySelectorAll(".count-btn");
const createBtn       = document.getElementById("create-btn");
const roomPanel       = document.getElementById("room-panel");
const roomCodeDisplay = document.getElementById("room-code-display");
const roomLinkInput   = document.getElementById("room-link-input");
const copyBtn         = document.getElementById("copy-btn");
const copyHint        = document.getElementById("copy-hint");

/* =========================================================
   STATE
========================================================= */

let selectedPlayerCount = null;

/* =========================================================
   RESTORE SESSION
========================================================= */

const savedName = sessionStorage.getItem("playerName");
if (savedName) playerNameInput.value = savedName;

/* =========================================================
   PLAYER COUNT SELECTION
========================================================= */

countBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        countBtns.forEach(b => {
            b.classList.remove("count-btn--active");
            b.setAttribute("aria-pressed", "false");
        });

        btn.classList.add("count-btn--active");
        btn.setAttribute("aria-pressed", "true");
        selectedPlayerCount = Number(btn.dataset.count);
        countError.textContent = "";
    });
});

/* =========================================================
   ROOM CODE GENERATOR
========================================================= */

function generateRoomCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
}

async function generateUniqueRoomCode() {
    while (true) {
        const roomCode = generateRoomCode();
        const snapshot = await get(ref(db, "rooms/" + roomCode));
        if (!snapshot.exists()) return roomCode;
    }
}

/* =========================================================
   CREATE ROOM IN FIREBASE
========================================================= */

async function createRoom(playerName, playerCount) {
    const roomCode = await generateUniqueRoomCode();

    await set(ref(db, "rooms/" + roomCode), {
        roomCode,
        status: "waiting",
        host: playerName,
        maxPlayers: playerCount,
        createdAt: Date.now(),

        /* Fixed: explicit turn order array so Firebase key ordering never matters */
        turnOrder: ["player1", "player2", "player3", "player4"],

        players: {
            player1: {
                name: playerName,
                color: "red",
                isHost: true,
                joinedAt: Date.now()
            }
        },

        game: {
            currentTurn: "player1",
            diceValue: 0,
            diceRolled: false,       /* NEW: tracks whether dice was rolled this turn */
            winner: null,
            tokens: {
                player1: { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
                player2: { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
                player3: { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } },
                player4: { t1: { index: -1 }, t2: { index: -1 }, t3: { index: -1 }, t4: { index: -1 } }
            }
        }
    });

    return roomCode;
}

/* =========================================================
   FORM VALIDATION
========================================================= */

function validateForm() {
    let valid = true;

    if (!playerNameInput.value.trim()) {
        nameError.textContent = "Please enter your name.";
        playerNameInput.focus();
        valid = false;
    } else {
        nameError.textContent = "";
    }

    if (!selectedPlayerCount) {
        countError.textContent = "Choose number of players.";
        valid = false;
    } else {
        countError.textContent = "";
    }

    return valid;
}

/* =========================================================
   CREATE GAME — button handler
========================================================= */

createBtn.addEventListener("click", async () => {
    if (!validateForm()) return;

    createBtn.disabled = true;
    createBtn.textContent = "Creating…";

    const playerName = playerNameInput.value.trim();
    sessionStorage.setItem("playerName", playerName);

    try {
        const roomCode = await createRoom(playerName, selectedPlayerCount);

        sessionStorage.setItem("roomCode", roomCode);
        sessionStorage.setItem("playerCount", selectedPlayerCount);
        sessionStorage.setItem("isHost", "true");
        sessionStorage.setItem("playerSlot", "player1");

        const base = window.location.href
            .split("?")[0]
            .replace(/index\.html$/, "");

        window.location.href = base + "room.html?code=" + roomCode;

    } catch (err) {
        console.error(err);
        alert("Failed to create room. Please try again.");
        createBtn.disabled = false;
        createBtn.innerHTML = '<span class="btn-create__icon" aria-hidden="true">🎲</span> Create Game';
    }
});

/* =========================================================
   LIVE VALIDATION
========================================================= */

playerNameInput.addEventListener("input", () => {
    if (playerNameInput.value.trim()) nameError.textContent = "";
});