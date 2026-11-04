/* Dispatch site: small enhancements. Every page is complete without this file. */
(() => {
  // Download page: put the visitor's own system first and highlight it.
  const ua = navigator.userAgent || "";
  const os = /Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua) ? "macos" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "linux" : "";
  if (os) {
    const el = document.querySelector('[data-os="' + os + '"]');
    if (el) { el.setAttribute("data-yours", ""); const t = el.querySelector("h3"); if (t) t.insertAdjacentHTML("beforeend", ' <span class="tag good">Your system</span>'); }
  }
  // Open the FAQ entry named in the URL hash.
  const open = () => { const d = document.querySelector("details" + (location.hash || "#none")); if (d) d.open = true; };
  addEventListener("hashchange", open); open();
})();
