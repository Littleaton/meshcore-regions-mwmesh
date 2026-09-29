// optional-tags.js — operator-selectable overlay tags.
//
// Renders the checkbox list defined by `optionalTags` in regions.json, with an
// accessible info bubble per entry. Self-contained: injects its own CSS once, so
// both the config wizard (inline <style>) and the map (public/styles.css) can use
// it without duplicating rules.
//
// Overlay tags are never geographic. They have no polygon, never appear as a
// resolution result, and are only added because the operator asked for them.
//
// Usage:
//   import { mountOptionalTags } from "../shared/optional-tags.js";
//   const optTags = mountOptionalTags({
//     container: document.getElementById("opt-tags"),
//     defs: OPTIONAL_TAGS,
//     hierarchy: HIERARCHY,
//     onChange: (tags) => { S.optionalTags = tags; recompute(); },
//   });
//   optTags.selected();   // -> selected tag names
//   optTags.reset();      // back to each entry's `default`

const STYLE_ID = "optional-tags-styles";

const CSS = `
.opt-tags { margin-top: 1.1rem; }
.opt-tags-divider { border: none; border-top: 1px solid var(--border, #d8e3dc); margin: 1.1rem 0; }
.opt-row { display: flex; align-items: center; gap: 0.5rem; position: relative; }
.opt-row[hidden] { display: none; }
.opt-tags-divider[hidden] { display: none; }

/* Highlighted group — wide-area scopes that deserve a second look before
   they're switched on. Warm/amber to read as "consider this", not "error". */
.opt-callout {
  margin: 0.55rem 0 0.9rem;
  padding: 0.75rem 0.9rem 0.8rem;
  border: 1.5px solid var(--gold-warm, #f4a261);
  border-radius: 11px;
  background: #fffbea;
}
.opt-callout[hidden] { display: none; }
.opt-callout-label {
  display: block;
  font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.09em; color: #92400e; margin-bottom: 0.45rem;
}
.opt-callout .opt-label { color: #7c3a06; }
.opt-callout .opt-info-btn { border-color: #e6c893; color: #a16207; background: #fff; }
.opt-callout .opt-info-btn:hover, .opt-callout .opt-info-btn:focus-visible {
  border-color: #b45309; color: #92400e;
}
.opt-row + .opt-row { margin-top: 0.55rem; }
.opt-label {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-size: 0.9rem; color: var(--text, #1b2b22);
  cursor: pointer; user-select: none; line-height: 1.35;
}
.opt-label input[type="checkbox"] {
  width: 15px; height: 15px; flex-shrink: 0; margin: 0;
  accent-color: var(--green, #2d6a4f); cursor: pointer;
}
.opt-info-btn {
  width: 17px; height: 17px; flex-shrink: 0; padding: 0;
  border-radius: 50%; border: 1.5px solid var(--border, #d8e3dc);
  background: var(--surface, #fff); color: var(--text-muted, #6b8177);
  font-family: inherit; font-size: 0.7rem; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: border-color 0.12s, color 0.12s;
}
.opt-info-btn:hover, .opt-info-btn:focus-visible {
  border-color: var(--green, #2d6a4f); color: var(--green-dark, #1b4332); outline: none;
}
.opt-info-pop {
  position: absolute; left: 0; top: calc(100% + 0.45rem); z-index: 30;
  max-width: 30rem;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #d8e3dc);
  border-radius: 9px;
  box-shadow: var(--shadow, 0 4px 16px rgba(0,0,0,0.10));
  padding: 0.7rem 0.85rem;
  font-size: 0.82rem; line-height: 1.45; color: var(--text-muted, #6b8177);
}
.opt-info-pop[hidden] { display: none; }
@media (max-width: 560px) { .opt-info-pop { max-width: none; right: 0; } }
`;

function injectStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

let uid = 0;

/**
 * @param {Object}      o
 * @param {HTMLElement} o.container   element to render into
 * @param {Array}       o.defs        regions.json `optionalTags`
 * @param {Object}      o.hierarchy   regions.json `hierarchy`
 * @param {Function}   [o.onChange]   called with the selected tag array
 * @param {boolean}    [o.divider]    draw a top divider (default true)
 * @param {Object}     [o.callout]    { label } heading for the highlighted group
 * @param {HTMLElement} [o.calloutContainer] render the highlighted group here
 *                      instead of inline — lets the callout sit next to the
 *                      controls it relates to (e.g. above the metro chips) while
 *                      the plain rows stay where they are
 * @returns {{selected: Function, reset: Function, count: number}}
 */
export function mountOptionalTags({ container, defs, hierarchy, onChange, divider = true, callout = null, calloutContainer = null }) {
  if (!container) throw new Error("mountOptionalTags: container is required");
  const doc = container.ownerDocument;
  injectStyles(doc);

  // Silently drop entries whose tag isn't in the hierarchy — a typo in
  // regions.json shouldn't emit a tag no node will ever match.
  const entries = (defs || []).filter((d) => d && d.tag && hierarchy[d.tag]);

  container.classList.add("opt-tags");
  if (calloutContainer) calloutContainer.classList.add("opt-tags");

  // Both containers are treated as one control for querying and event binding.
  const roots = [container, calloutContainer].filter(Boolean);
  const queryAll = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);

  if (!entries.length) {
    for (const r of roots) { r.innerHTML = ""; r.hidden = true; }
    return { selected: () => [], reset: () => {}, refresh: () => 0, count: 0 };
  }
  container.hidden = false;

  const ns = `opt${uid++}`;

  const rowHtml = (d, i) => {
        const popId = `${ns}-pop-${i}`;
        const label = d.label || hierarchy[d.tag].label || d.tag;
        // Screen readers get the full region name rather than the checkbox's short
        // call to action using the configured program or region name rather
        // than repeating the checkbox label.
        const infoName = hierarchy[d.tag].label || label;
        const info = d.info
          ? `<button type="button" class="opt-info-btn" data-pop="${popId}"
                     aria-expanded="false" aria-controls="${popId}"
                     aria-label="About ${esc(infoName)}">i</button>
             <div class="opt-info-pop" id="${popId}" role="note" hidden>${esc(d.info)}</div>`
          : "";
        return `<div class="opt-row" data-tag="${esc(d.tag)}">
            <label class="opt-label">
              <input type="checkbox" value="${esc(d.tag)}"${d.default ? " checked" : ""}>
              ${esc(label)}
            </label>${info}
          </div>`;
  };

  // Entries flagged `highlight` are pulled into a bordered callout so they read as
  // a deliberate choice rather than one more checkbox.
  const plain = entries.filter((d) => !d.highlight);
  const flagged = entries.filter((d) => d.highlight);

  const calloutHtml = flagged.length
    ? `<div class="opt-callout">` +
      (callout && callout.label
        ? `<span class="opt-callout-label">${esc(callout.label)}</span>`
        : "") +
      flagged.map((d) => rowHtml(d, entries.indexOf(d))).join("") +
      `</div>`
    : "";

  container.innerHTML =
    (divider ? '<hr class="opt-tags-divider">' : "") +
    plain.map((d) => rowHtml(d, entries.indexOf(d))).join("") +
    (calloutContainer ? "" : calloutHtml);

  if (calloutContainer) calloutContainer.innerHTML = calloutHtml;

  const boxes = () => queryAll('input[type="checkbox"]');
  const rowOf = (box) => box.closest(".opt-row");
  // A hidden row's state is irrelevant to the current repeater type, so it is not
  // reported as selected.
  const selected = () =>
    boxes().filter((b) => b.checked && !rowOf(b).hidden).map((b) => b.value);

  for (const r of roots) {
    r.addEventListener("change", () => {
      if (typeof onChange === "function") onChange(selected());
    });
  }

  // ── Info bubbles ──────────────────────────────────────────────────────────
  const closeAll = () => {
    queryAll(".opt-info-pop").forEach((p) => { p.hidden = true; });
    queryAll(".opt-info-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };

  queryAll(".opt-info-btn").forEach((btn) => {
    const pop = doc.getElementById(btn.dataset.pop);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = btn.getAttribute("aria-expanded") === "true";
      closeAll();
      if (!wasOpen) {
        pop.hidden = false;
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  for (const r of roots) {
    r.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  }
  doc.addEventListener("click", (e) => {
    if (!roots.some((r) => r.contains(e.target))) closeAll();
  });

  // Show only the rows whose `showFor` includes this repeater type (entries with
  // no showFor are always visible). Checked state survives a refresh.
  const refresh = (repeaterType) => {
    let visible = 0;
    for (const row of queryAll(".opt-row")) {
      const def = entries.find((d) => d.tag === row.dataset.tag);
      const show = !def || !Array.isArray(def.showFor) || def.showFor.includes(repeaterType);
      row.hidden = !show;
      if (show) visible++;
    }
    const box = queryAll(".opt-callout")[0];
    if (box) {
      box.hidden = ![...box.querySelectorAll(".opt-row")].some((r) => !r.hidden);
    }
    // The main container's visibility follows its own rows only — the callout may
    // live elsewhere and hide independently.
    const plainVisible = [...container.querySelectorAll(".opt-row")].some((r) => !r.hidden);
    const dividerEl = container.querySelector(".opt-tags-divider");
    if (dividerEl) dividerEl.hidden = !plainVisible;
    container.hidden = !plainVisible;
    if (calloutContainer) calloutContainer.hidden = !box || box.hidden;
    closeAll();
    if (typeof onChange === "function") onChange(selected());
    return visible;
  };

  const reset = () => {
    boxes().forEach((b) => {
      const def = entries.find((d) => d.tag === b.value);
      b.checked = !!(def && def.default);
    });
    closeAll();
    if (typeof onChange === "function") onChange(selected());
  };

  if (typeof onChange === "function") onChange(selected());

  return { selected, reset, refresh, count: entries.length };
}
