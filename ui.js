/* ui.js — tiny shared UI helpers (toasts + clipboard). No game logic here. */

let region = null;

function getRegion() {
    if (region && document.body.contains(region)) return region;
    region = document.getElementById("toast-region");
    if (!region) {
        region = document.createElement("div");
        region.id = "toast-region";
        region.className = "toast-region";
        region.setAttribute("role", "status");
        region.setAttribute("aria-live", "polite");
        document.body.appendChild(region);
    }
    return region;
}

/* tone: "default" | "error" | "red" | "blue" | "green" | "yellow" */
export function showToast(message, tone = "default", duration = 3200) {
    const host  = getRegion();
    const toast = document.createElement("div");
    toast.className = "toast" + (tone !== "default" ? ` toast--${tone}` : "");
    toast.textContent = message;
    host.appendChild(toast);

    // keep the stack short
    while (host.children.length > 3) host.firstElementChild.remove();

    setTimeout(() => {
        toast.classList.add("toast--out");
        setTimeout(() => toast.remove(), 200);
    }, duration);
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const tmp = document.createElement("input");
        tmp.value = text;
        tmp.setAttribute("readonly", "");
        tmp.style.position = "fixed";
        tmp.style.opacity = "0";
        document.body.appendChild(tmp);
        tmp.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch { /* ignore */ }
        document.body.removeChild(tmp);
        return ok;
    }
}
