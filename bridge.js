(() => {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("injector.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();