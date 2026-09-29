(function () {
  "use strict";

  const COOKIE = "mwmesh_theme";
  const ONE_YEAR = 60 * 60 * 24 * 365;

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function updateThemeControls() {
    const light = currentTheme() === "light";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const icon = button.querySelector("[data-theme-icon]");
      if (icon) icon.textContent = light ? "☀" : "☾";
      button.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
    });
  }

  function toggleTheme() {
    const next = currentTheme() === "light" ? "dark" : "light";
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    document.cookie = `${COOKIE}=${next}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
    updateThemeControls();
  }

  window.toggleMwmeshTheme = toggleTheme;

  function initNavigation() {
    const menuButton = document.querySelector("[data-menu-toggle]");
    const mobileNav = document.querySelector("[data-mobile-nav]");
    if (!menuButton || !mobileNav) return;

    function closeMenu() {
      mobileNav.classList.remove("open");
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.textContent = "☰";
    }

    menuButton.addEventListener("click", () => {
      const open = mobileNav.classList.toggle("open");
      menuButton.setAttribute("aria-expanded", String(open));
      menuButton.textContent = open ? "×" : "☰";
    });
    mobileNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }

  function init() {
    updateThemeControls();
    initNavigation();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
