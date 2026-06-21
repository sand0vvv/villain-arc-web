// ============================================================================
// VILLAIN ARC — Lobby boot
// Wires the 3D scene + UI once the DOM and CDN libs are ready.
// ============================================================================
(function () {
  "use strict";
  function boot() {
    try {
      window.LobbyScene.init();
    } catch (e) {
      console.error("[lobby] 3D init failed:", e);
    }
    try {
      window.LobbyUI.init();
    } catch (e) {
      console.error("[lobby] UI init failed:", e);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
