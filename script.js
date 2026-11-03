import { db } from "./firebase.js";
import {
    ref,
    set,
    get
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";
import { showToast, copyText } from "./ui.js";

/* =========================================================
   ELEMENTS
========================================================= */

const nameInput   = document.getElementById("player-name");
const nameError   = document.getElementById("name-error");

const countBtns   = document.querySelectorAll(".count-btn");
const countError  = document.getElementById("count-error");

const createBtn   = document.getElementById("create-btn");

const roomPanel        = document.getElementById("room-panel");
const roomCodeDisplay  = document.getElementById("room-code-display");
const roomLinkInput    = document.getElementById("room-link-input");
const copyBtn          = document.getElementById("copy-btn");
const copyHint         = document.getElementById("copy-hint");

const joinCodeInput = document.getElementById("join-code");
const joinBtn        = document.getElementById("join-btn");
const joinError       = document.getElementById("join-error");

const COLOR_MAP = { player1: "red", player2: "blue", player3: "green", player4: "yellow" };

let selectedCount = null;

/* =========================================================
   CREATE / JOIN TABS  (UI only)
========================================================= */

const tabs  = [document.getElementById("tab-create"), document.getElementById("tab-join")];
const panes = [document.getElementById("pane-create"), document.getElementById("pane-join")];

function selectTab(index, focus) {
    tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        panes[i].hidden = !on;
    });
    if (focus) tabs[index].focus();
}

tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(i));
    tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            selectTab((i + 1) % tabs.length, true);
        }
    });
});

// Landing on /index.html#join (or arriving with a ?code=) opens the join tab.
if (location.hash === "#join") selectTab(1);

/* =========================================================
   PLAYER COUNT SELECTION
========================================================= */

countBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        countBtns.forEach((b) => {
            b.classList.remove("count-btn--active");
            b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("count-btn--active");
        btn.setAttribute("aria-pressed", "true");
        selectedCount = parseInt(btn.dataset.count, 10);
        countError.textContent = "";
    });
});

/* Small helpers for the loading state of the primary buttons */
function setBusy(btn, busy, busyLabel) {
    const label = btn.querySelector(".btn__label");
    if (busy) {
        btn.dataset.idleLabel = label.textContent;
        label.textContent = busyLabel;
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        const spin = document.createElement("span");
        spin.className = "spinner";
        spin.setAttribute("aria-hidden", "true");
        btn.insertBefore(spin, btn.firstChild);
        btn.querySelector("svg")?.setAttribute("hidden", "");
    } else {
        label.textContent = btn.dataset.idleLabel || label.textContent;
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.querySelector(".spinner")?.remove();
        btn.querySelector("svg")?.removeAttribute("hidden");
    }
}

nameInput.addEventListener("input", () => {
    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");
});

/* =========================================================
   SHARED HELPERS
========================================================= */

function validateName() {
    const name = nameInput.value.trim();
    if (!name) {
        nameError.textContent = "Enter your name so friends know who you are.";
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return null;
    }
    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");
    return name;
}

/* Unambiguous character set (no 0/O, 1/I) for room codes */
function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

async function getUniqueCode() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const code = generateCode();
        const snap = await get(ref(db, "rooms/" + code));
        if (!snap.exists()) return code;
    }
    throw new Error("Could not generate a unique room code.");
}

function roomUrlFor(code) {
    const base = window.location.href.split("?")[0].replace(/index\.html$/, "");
    return base + "room.html?code=" + code;
}

/* =========================================================
   CREATE GAME
========================================================= */

createBtn.addEventListener("click", async () => {
    const name = validateName();
    if (!name) return;

    if (!selectedCount) {
        countError.textContent = "Choose how many players will join.";
        return;
    }
    countError.textContent = "";

    setBusy(createBtn, true, "Creating room…");

    try {
        const code = await getUniqueCode();

        await set(ref(db, "rooms/" + code), {
            code,
            status: "waiting",
            maxPlayers: selectedCount,
            turnOrder: ["player1", "player2", "player3", "player4"],
            createdAt: Date.now(),
            players: {
                player1: {
                    name,
                    color: COLOR_MAP.player1,
                    isHost: true,
                    joinedAt: Date.now()
                }
            }
        });

        sessionStorage.setItem("playerSlot", "player1");
        sessionStorage.setItem("isHost", "true");
        sessionStorage.setItem("playerName", name);

        showRoomCreated(code);
    } catch (err) {
        console.error("Failed to create room:", err);
        countError.textContent = "Couldn't create the room. Check your connection and try again.";
        setBusy(createBtn, false);
    }
});

function showRoomCreated(code) {
    const url = roomUrlFor(code);

    roomCodeDisplay.textContent = code;
    roomCodeDisplay.classList.remove("pop");
    void roomCodeDisplay.offsetWidth; // restart pop animation
    roomCodeDisplay.classList.add("pop");

    roomLinkInput.value = url;
    copyHint.textContent = "";

    roomPanel.closest(".panel")?.classList.add("is-created");
    roomPanel.hidden = false;
    roomPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Host goes straight into the room they just created
    setTimeout(() => {
        window.location.href = url;
    }, 900);
}

/* =========================================================
   COPY INVITE LINK
========================================================= */

copyBtn.addEventListener("click", async () => {
    await copyText(roomLinkInput.value);
    copyHint.textContent = "Invite link copied";
    setTimeout(() => { copyHint.textContent = ""; }, 2500);
});

/* =========================================================
   JOIN WITH CODE
========================================================= */

/* FIXED: the old version did `joinCodeInput.value = <cleaned>` on every
   keystroke. Reassigning .value always snaps the cursor to the END of
   the field — but on mobile keyboards (autocapitalize + predictive
   text/autocorrect), the caret isn't always at the true end while
   you're mid-word, so that forced jump fights with the keyboard and
   the last couple of characters you type land in the wrong spot or
   never make it into the field at all.

   Fix: skip the transform entirely while an IME/predictive-text
   composition is in progress (e.isComposing), and when we DO clean the
   value, explicitly restore the cursor to where it logically should be
   (shifted back by however many characters were stripped) instead of
   letting it default to the end. */
joinCodeInput.addEventListener("input", (e) => {
    if (e.isComposing) return; // let the composition finish before touching the value

    const input = e.target;
    const prevValue = input.value;
    const prevPos   = input.selectionStart ?? prevValue.length;

    const cleaned = prevValue.toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (cleaned !== prevValue) {
        input.value = cleaned;

        // Shift the cursor back by exactly how many characters were
        // removed/changed before it, so typing feels continuous instead
        // of jumping to the end and clobbering whatever comes next.
        const removedBeforeCursor = prevValue.length - cleaned.length;
        const newPos = Math.max(0, prevPos - removedBeforeCursor);
        input.setSelectionRange(newPos, newPos);
    }

    clearJoinError();
});

function setJoinError(message) {
    joinError.textContent = message;
    joinCodeInput.setAttribute("aria-invalid", "true");
}

function clearJoinError() {
    joinError.textContent = "";
    joinCodeInput.removeAttribute("aria-invalid");
}

/* Pulls a 6-character code out of whatever was pasted: a bare code,
   or a full invite link ending in ?code=XXXXXX. */
function extractCode(text) {
    const fromLink = text.match(/[?&]code=([A-Za-z0-9]+)/);
    const raw = fromLink ? fromLink[1] : text;
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/* "Paste" button — one tap on mobile instead of long-press → paste. */
document.getElementById("paste-btn")?.addEventListener("click", async () => {
    try {
        const text = await navigator.clipboard.readText();
        const code = extractCode(text || "");
        if (!code) {
            setJoinError("Your clipboard doesn't have a room code.");
            return;
        }
        joinCodeInput.value = code;
        clearJoinError();
        joinCodeInput.focus();
    } catch {
        // Clipboard read blocked (permissions / insecure context) — fall back to manual paste.
        joinCodeInput.focus();
        showToast("Press and hold in the box to paste", "default");
    }
});

/* NEW: if someone pastes the whole invite link (not just the code),
   extract just the ?code=XXXXXX part instead of leaving a mangled
   mess of URL characters in the field. */
joinCodeInput.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const match = pasted.match(/[?&]code=([A-Za-z0-9]+)/);
    if (match) {
        e.preventDefault();
        joinCodeInput.value = match[1].toUpperCase().slice(0, 6);
        clearJoinError();
    }
    // otherwise let the normal paste + "input" handler above clean it up
});

joinCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        joinRoom();
    }
});

joinBtn.addEventListener("click", joinRoom);

/* CHANGED: joining no longer requires a name up front. The name field
   on this page is only used by "Create Game" now. Room.html is
   responsible for collecting the player's name once they land there
   (via its own join-card, as the old comment already anticipated). */
async function joinRoom() {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (!code) {
        setJoinError("Enter the 6-character room code.");
        joinCodeInput.focus();
        return;
    }
    clearJoinError();

    setBusy(joinBtn, true, "Checking room…");

    let navigating = false;

    try {
        const snap = await get(ref(db, "rooms/" + code));

        if (!snap.exists()) {
            setJoinError("No room found with that code. Check it and try again.");
            return;
        }

        const room = snap.val();

        if (room.status === "playing") {
            setJoinError("That game has already started.");
            return;
        }

        const filled = Object.keys(room.players || {}).length;
        if (room.maxPlayers && filled >= room.maxPlayers) {
            setJoinError("That room is full.");
            return;
        }

        // No name collected here anymore — room.html's join-card
        // prompts for the name and completes the join itself.
        navigating = true;
        window.location.href = "room.html?code=" + code;
    } catch (err) {
        console.error("Failed to look up room:", err);
        setJoinError("Couldn't reach the room. Check your connection and try again.");
    } finally {
        // keep the spinner up while the browser navigates away
        if (!navigating) setBusy(joinBtn, false);
    }
}
/* Coming back via the browser's back button restores the page from cache with
   the buttons still in their loading state — reset them. */
window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    if (joinBtn.disabled) setBusy(joinBtn, false);
    if (createBtn.disabled && roomPanel.hidden) setBusy(createBtn, false);
});
