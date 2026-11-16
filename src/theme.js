// 描画前にテーマを適用してちらつきを防ぐ
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("eiyaku.settings") || "{}");
    var theme = s.theme || "system";
    var dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.ui = s.uiScale || "normal";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
