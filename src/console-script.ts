/**
 * The only script of the console, served at /console.js. It marks a POST form busy on submit,
 * cancels a later submit of that form, and disables its buttons in a 0 ms timeout, after the
 * browser has built the form data set, so the submitter's name and value are still sent. A page
 * restored from the back/forward cache is made usable again. A `button[data-copy]` is shown and
 * copies the `textContent` of the element it names (Decision 12); without the script the text
 * stays selectable in its `<pre>`. On `pagehide` and on a persisted `pageshow` every
 * `[data-secret]` element loses its text, so a back/forward cache restore shows no secret. Every
 * `time[data-countdown]` counts down once a second from its `datetime`; one interval serves all
 * of them, it starts only while one is above zero and stops when all reach zero or on `pagehide`.
 * A form with `data-preview-form` updates the `.incident-preview` parts of its page on every
 * `input` and `change`, only through `textContent` and `hidden`; it adds no timer.
 * Plain ES2020, no page data, no request and no storage.
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
  document.querySelectorAll("button[data-copy]").forEach(function (button) {
    var source = document.getElementById(button.getAttribute("data-copy") || "");
    if (!source || !navigator.clipboard) return;
    button.hidden = false;
    button.addEventListener("click", function () {
      navigator.clipboard.writeText(source.textContent || "").then(
        function () {
          button.textContent = "Copied";
        },
        function () {
          button.textContent = "Copy failed: select the text";
        },
      );
    });
  });
  function setPart(root, name, text) {
    var element = root.querySelector('[data-part="' + name + '"]');
    if (element) element.textContent = text;
  }
  function checkedValue(form, name) {
    var input = form.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : null;
  }
  function renderPreview(form) {
    var preview = document.querySelector(".incident-preview");
    if (!preview) return;
    var title = form.querySelector('input[name="title"]');
    if (title) setPart(preview, "title", title.value);
    var impact = checkedValue(form, "impact");
    if (impact !== null) setPart(preview, "impact", "Impact: " + impact);
    var status = checkedValue(form, "status");
    var updates = preview.querySelectorAll('[data-part="update"]');
    var last = updates.length > 0 ? updates[updates.length - 1] : null;
    if (status !== null) {
      setPart(preview, "status", "Status: " + status);
      if (last) setPart(last, "update-status", status);
    }
    var message = form.querySelector('textarea[name="message"]');
    if (message && last) setPart(last, "message", message.value.replace(/\\r\\n?/g, "\\n"));
    var boxes = form.querySelectorAll('input[name="component"]');
    var affects = preview.querySelector('[data-part="affects"]');
    if (boxes.length === 0 || !affects) return;
    var names = [];
    boxes.forEach(function (box) {
      if (box.checked) names.push(box.getAttribute("data-name") || box.value);
    });
    affects.textContent = "Affects: " + names.join(", ");
    affects.hidden = names.length === 0;
  }
  function onPreviewInput(event) {
    var target = event.target;
    var form = target && target.form;
    if (form instanceof HTMLFormElement && form.hasAttribute("data-preview-form")) {
      renderPreview(form);
    }
  }
  document.addEventListener("input", onPreviewInput);
  document.addEventListener("change", onPreviewInput);
  var HIDDEN = "Hidden: the secret was shown once.";
  function clearSecrets() {
    document.querySelectorAll("[data-secret]").forEach(function (element) {
      element.textContent = HIDDEN;
    });
  }
  var timer = null;
  function stopTimer() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function tick() {
    var running = 0;
    document.querySelectorAll("time[data-countdown]").forEach(function (element) {
      var until = Date.parse(element.getAttribute("datetime") || "");
      var left = isNaN(until) ? 0 : Math.max(0, Math.floor((until - Date.now()) / 1000));
      element.textContent = left > 0 ? pad(Math.floor(left / 60)) + ":" + pad(left % 60) : "ended";
      if (left > 0) running += 1;
    });
    if (running === 0) stopTimer();
    return running;
  }
  if (document.querySelector("time[data-countdown]") && tick() > 0) {
    timer = setInterval(tick, 1000);
  }
  window.addEventListener("pagehide", function () {
    clearSecrets();
    stopTimer();
  });
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    clearSecrets();
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
