/**
 * The only script of the console, served at /console.js. It marks a POST form busy on submit,
 * cancels a later submit of that form, and disables its buttons in a 0 ms timeout, after the
 * browser has built the form data set, so the submitter's name and value are still sent. A page
 * restored from the back/forward cache is made usable again. Plain ES2020, no page data, no
 * request and no storage.
 */
export const CONSOLE_JS = `"use strict";
(function () {
  var busy = new WeakSet();
  var saved = [];
  function buttonsOf(form) {
    return form.querySelectorAll('button[type="submit"], input[type="submit"]');
  }
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.method !== "post") return;
    if (event.defaultPrevented) return;
    if (busy.has(form)) {
      event.preventDefault();
      return;
    }
    busy.add(form);
    var submitter = event.submitter;
    setTimeout(function () {
      buttonsOf(form).forEach(function (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      });
      var label = submitter ? submitter.getAttribute("data-busy-label") : null;
      if (submitter instanceof HTMLButtonElement && label) {
        saved.push({ button: submitter, text: submitter.textContent });
        submitter.textContent = label;
      }
    }, 0);
  });
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    saved.forEach(function (entry) {
      entry.button.textContent = entry.text;
    });
    saved = [];
    document.querySelectorAll("form").forEach(function (form) {
      busy.delete(form);
      buttonsOf(form).forEach(function (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      });
    });
  });
})();
`;
