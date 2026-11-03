/* =========================================================
   DEVELOPER PANEL (private)
   - Tap the "Ludo" logo 5 times quickly -> passphrase prompt.
   - Only a salted SHA-256 hash of the passphrase lives here.
   - The unlocked state is re-verified against the hash on every
     use, so setting a flag in dev tools does nothing.
   - Nothing is written to the shared room data: a forced roll
     looks identical to a normal one for everyone else.
   To change the passphrase, replace PASS_HASH with:
     sha256("ludo-dev-v1" + yourNewPassphrase)  (hex)
========================================================= */

const SALT      = "ludo-dev-v1";
const PASS_HASH = "6781e4135806d85caa027aa08250f554e574b0407951dec2b70e2807cb4985b1";
const STORE_KEY = "ludoDevKey";

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isValid(pass) {
    try { return !!pass && (await sha256Hex(SALT + pass)) === PASS_HASH; }
    catch { return false; }
}

let unlocked = false;   // verified in this page load
let forced   = 0;       // 0 = random, 1-6 = forced roll

async function checkStored() {
    let pass = null;
    try { pass = localStorage.getItem(STORE_KEY); } catch {}
    unlocked = await isValid(pass);
    return unlocked;
}

/* Called by room.js when rolling. Returns 1-6 or null (= roll normally). */
export function getCheatDice() {
    return unlocked && forced >= 1 && forced <= 6 ? forced : null;
}

function buildPanel() {
    if (document.getElementById("dev-panel")) return;
    const el = document.createElement("div");
    el.id = "dev-panel";
    el.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99999;background:#0b1220ee;" +
        "border:1px solid #2a3650;border-radius:12px;padding:10px 12px;color:#e8edf7;" +
        "font:600 12px system-ui,sans-serif;box-shadow:0 10px 30px #0008;max-width:240px";
    el.innerHTML = '<div style="margin-bottom:8px;opacity:.7">Dev · next rolls</div>' +
        '<div id="dev-btns" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px">' +
        '<button data-act="hide" style="flex:1">Hide</button>' +
        '<button data-act="lock" style="flex:1">Lock</button></div>';
    const btns = el.querySelector("#dev-btns");
    const style = "padding:6px 9px;border-radius:8px;border:1px solid #2a3650;background:#141c2e;color:inherit;font:inherit;cursor:pointer";
    const mk = (label, val) => {
        const b = document.createElement("button");
        b.textContent = label; b.style.cssText = style; b.dataset.val = val;
        b.onclick = () => { forced = val; paint(); };
        btns.appendChild(b);
    };
    mk("Random", 0);
    for (let i = 1; i <= 6; i++) mk(String(i), i);
    el.querySelectorAll("[data-act]").forEach(b => { b.style.cssText = style; });
    el.querySelector('[data-act="hide"]').onclick = () => el.remove();
    el.querySelector('[data-act="lock"]').onclick = () => {
        try { localStorage.removeItem(STORE_KEY); } catch {}
        unlocked = false; forced = 0; el.remove();
    };
    function paint() {
        btns.querySelectorAll("button").forEach(b => {
            const on = Number(b.dataset.val) === forced;
            b.style.background = on ? "#0f8f6f" : "#141c2e";
        });
    }
    document.body.appendChild(el);
    paint();
}

async function promptUnlock() {
    if (unlocked || await checkStored()) { buildPanel(); return; }
    const pass = window.prompt("Passphrase");
    if (pass && await isValid(pass)) {
        try { localStorage.setItem(STORE_KEY, pass); } catch {}
        unlocked = true;
        buildPanel();
    }
}

/* Tap the logo 5 times within ~3s. A single tap still navigates home. */
function bindLogo() {
    let taps = 0, timer = null;
    document.addEventListener("click", (e) => {
        const brand = e.target.closest && e.target.closest(".brand");
        if (!brand) return;
        e.preventDefault();
        taps++;
        clearTimeout(timer);
        if (taps >= 5) { taps = 0; promptUnlock(); return; }
        timer = setTimeout(() => {
            const was = taps; taps = 0;
            if (was === 1 && brand.href) window.location.href = brand.href;
        }, 650);
    });
}

checkStored();
bindLogo();
