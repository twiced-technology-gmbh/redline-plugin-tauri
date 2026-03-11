/**
 * Redline — Annotation Overlay
 * Dev-only tool for annotating UI elements with feedback.
 * Press Cmd+Option+Shift+A (Mac) or Ctrl+Alt+Shift+A (Win/Linux) to toggle annotation mode.
 * Requires Fabric.js 5.x to be loaded before this script.
 */
(function () {
  'use strict';

  // Prevent double-init
  if (window.__redline_initialized) return;
  window.__redline_initialized = true;

  const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let active = false;
  let fabricCanvas = null;
  let annotations = [];
  let sessionName = '';
  let overlayEl = null;
  let toolbarEl = null;
  let currentTool = 'select'; // 'select' | 'arrow' | 'circle' | 'box' | 'freehand' | 'text' | 'edit'
  let isSelectBusy = false; // guard against multiple popups
  let annotationObjects = []; // tracks {highlight, label} fabric objects per annotation for undo
  let pendingSelect = null; // { element, highlight, badgeEl, originalElement } — element being selected before confirming
  let autosaveInterval = null;
  let activeTooltips = []; // track all tooltip DOM elements for cleanup

  // Dismiss all tooltips on any click (except clicks inside searchable tooltips)
  document.addEventListener('pointerdown', function (e) {
    if (!activeTooltips.length) return;
    var insideTooltip = activeTooltips.some(function (t) { return t.contains(e.target); });
    if (!insideTooltip) {
      activeTooltips.forEach(function (t) { if (t.parentNode) t.remove(); });
      activeTooltips = [];
    }
  }, true);

  const STORAGE_KEY = '__redline_session';

  function persistSession() {
    if (!active) return;
    var canvasJson = fabricCanvas ? JSON.stringify(fabricCanvas.toJSON(['_redlineIndex', '_isLabelBg'])) : null;
    // Capture pending selection state
    var pendingState = null;
    if (pendingSelect && pendingSelect.element) {
      var ta = pendingSelect.badgeEl ? pendingSelect.badgeEl.querySelector('textarea') : null;
      var elRect = pendingSelect.element.getBoundingClientRect();
      pendingState = {
        selector: getCssSelector(pendingSelect.element),
        cx: Math.round(elRect.left + elRect.width / 2),
        cy: Math.round(elRect.top + elRect.height / 2),
        comment: ta ? ta.value : '',
        editIndex: pendingSelect.editIndex != null ? pendingSelect.editIndex : null
      };
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionName: sessionName,
      annotations: annotations,
      canvasJson: canvasJson,
      currentTool: currentTool,
      pendingState: pendingState
    }));
  }

  function getSavedSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSavedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function requireFabric() {
    if (!window.fabric) throw new Error('[Redline] Fabric.js must be loaded before annotation-overlay.js');
  }

  // --- Capture computed HTML + CSS for an element ---
  var CURATED_CSS_PROPS = [
    // Layout
    'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'gap', 'row-gap', 'column-gap',
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'align-items', 'justify-content', 'align-self',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'top', 'right', 'bottom', 'left', 'z-index', 'overflow', 'overflow-x', 'overflow-y',
    // Visual
    'color', 'background-color', 'background', 'border', 'border-radius', 'box-shadow', 'opacity',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    // Typography
    'font-size', 'font-weight', 'font-family', 'line-height', 'text-align', 'text-decoration',
    'letter-spacing', 'white-space', 'text-overflow',
    // Transform
    'transform', 'transition'
  ];

  function getComputedSnapshot(el) {
    var computed = window.getComputedStyle(el);
    var computedCss = {};
    for (var i = 0; i < CURATED_CSS_PROPS.length; i++) {
      var val = computed.getPropertyValue(CURATED_CSS_PROPS[i]);
      if (val && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '0px' && val !== 'rgba(0, 0, 0, 0)') {
        computedCss[CURATED_CSS_PROPS[i]] = val;
      }
    }

    // Outer HTML — just the element itself, not deep children (to keep size manageable)
    var clone = el.cloneNode(false);
    var computedHtml = clone.outerHTML;
    // Also capture a shallow version with direct text + child tag hints
    var childHints = [];
    for (var i = 0; i < el.childNodes.length && childHints.length < 10; i++) {
      var child = el.childNodes[i];
      if (child.nodeType === 3 && child.textContent.trim()) {
        childHints.push(child.textContent.trim().substring(0, 50));
      } else if (child.nodeType === 1) {
        childHints.push('<' + child.tagName.toLowerCase() + (child.className ? ' class="' + child.className + '"' : '') + '>');
      }
    }

    return {
      computedCss: computedCss,
      html: computedHtml,
      childHints: childHints
    };
  }

  // --- CSS selector generator ---
  function getCssSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let seg = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
          seg += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      // Add :nth-child() when siblings share the same tag+class combo
      if (current.parentElement) {
        var siblings = Array.from(current.parentElement.children).filter(function (s) {
          return s.tagName === current.tagName && s.className === current.className;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          seg += ':nth-child(' + (Array.from(current.parentElement.children).indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(seg);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // --- Toast notification ---
  function showToast(msg, duration) {
    duration = duration || 3000;
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
      background: '#1a1a2e', color: '#fff', padding: '12px 20px', borderRadius: '8px',
      fontSize: '14px', fontFamily: 'system-ui, sans-serif', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      transition: 'opacity 0.3s', opacity: '1'
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
  }

  // --- Resume dialog ---
  function showResumeDialog(saved) {
    return new Promise((resolve) => {
      var count = saved.annotations.length;
      var backdrop = document.createElement('div');
      Object.assign(backdrop.style, {
        position: 'fixed', inset: '0', zIndex: '2147483646',
        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center'
      });
      var dialog = document.createElement('div');
      Object.assign(dialog.style, {
        background: '#1a1a2e', borderRadius: '12px', padding: '24px', minWidth: '360px',
        fontFamily: 'system-ui, sans-serif', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', color: '#e0e0e0'
      });
      var heading = document.createElement('h3');
      heading.textContent = 'Redline — Session Found';
      Object.assign(heading.style, { margin: '0 0 8px', fontSize: '16px', color: '#fff' });
      dialog.appendChild(heading);

      var desc = document.createElement('p');
      desc.innerHTML = 'Session <strong style="color:#fff;">' + saved.sessionName + '</strong> has ' + count + ' annotation' + (count !== 1 ? 's' : '') + '.';
      Object.assign(desc.style, { margin: '0 0 16px', fontSize: '13px', color: '#aaa' });
      dialog.appendChild(desc);

      function finish(val) { backdrop.remove(); resolve(val); }

      var footer = buildDialogFooter({
        hint: 'Resume or start fresh',
        tooltipDelay: 0,
        onDelete: function () { clearSavedSession(); finish('new'); },
        deleteTip: 'Discard & New',
        cancelTip: 'Cancel',
        onCancel: function () { clearSavedSession(); finish(null); },
        actionIcon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,4 20,12 6,20"/></svg>',
        actionTip: 'Resume session',
        onAction: function () { finish('resume'); }
      });
      dialog.appendChild(footer);

      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      backdrop.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { clearSavedSession(); finish(null); }
      });
      backdrop.setAttribute('tabindex', '-1');
      backdrop.focus();
    });
  }

  // --- Name dialog ---
  function showNameDialog() {
    return new Promise((resolve) => {
      const route = window.location.pathname.replace(/\//g, '-').replace(/^-/, '') || 'home';
      const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const defaultName = route + '-' + ts;

      const backdrop = document.createElement('div');
      Object.assign(backdrop.style, {
        position: 'fixed', inset: '0', zIndex: '2147483646',
        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center'
      });

      const dialog = document.createElement('div');
      Object.assign(dialog.style, {
        background: '#1a1a2e', borderRadius: '12px', padding: '24px', minWidth: '360px',
        fontFamily: 'system-ui, sans-serif', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', color: '#e0e0e0'
      });
      var heading = document.createElement('h3');
      heading.textContent = 'Redline — New Annotation Session';
      Object.assign(heading.style, { margin: '0 0 12px', fontSize: '16px', color: '#fff' });
      dialog.appendChild(heading);

      var label = document.createElement('label');
      label.textContent = 'Session name:';
      Object.assign(label.style, { fontSize: '13px', color: '#aaa' });
      dialog.appendChild(label);

      var input = document.createElement('input');
      input.type = 'text';
      input.value = defaultName;
      Object.assign(input.style, {
        width: '100%', padding: '8px', margin: '8px 0 16px', border: '1px solid #444',
        borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box',
        background: '#0d0d1a', color: '#fff', outline: 'none'
      });
      dialog.appendChild(input);

      function finish(val) { backdrop.remove(); resolve(val); }

      var playSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,4 20,12 6,20"/></svg>';
      var footer = buildDialogFooter({
        hint: 'Name your session',
        tooltipDelay: 0,
        cancelTip: 'Cancel',
        onCancel: function () { finish(null); },
        actionIcon: playSvg,
        actionTip: 'Start session',
        onAction: function () { finish(input.value.trim() || defaultName); }
      });
      dialog.appendChild(footer);

      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      input.select();
      input.focus();

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') finish(input.value.trim() || defaultName);
        if (e.key === 'Escape') finish(null);
      });
    });
  }

  // --- Shared dialog footer: hint (left) + icon buttons (right) ---
  var xSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var plusSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var pencilSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  var trashSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
  var sendBackSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="4" y="4" width="8" height="8" rx="1"/><rect x="12" y="12" width="8" height="8" rx="1" fill="currentColor" opacity="0.3"/><path d="M12 16H8a1 1 0 0 1-1-1v-4"/></svg>';
  var pointerSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="m4 4 7.07 16.97 2.51-7.39 7.39-2.51L4 4z"/></svg>';
  var undoSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
  var redoSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/></svg>';

  function iconBtn(svg, style) {
    var btn = document.createElement('button');
    btn.innerHTML = svg;
    Object.assign(btn.style, {
      width: '32px', height: '32px', border: 'none', borderRadius: '6px',
      cursor: 'pointer', padding: '0', display: 'flex',
      alignItems: 'center', justifyContent: 'center', lineHeight: '0',
      transition: 'all 0.15s', boxSizing: 'border-box'
    });
    Object.assign(btn.style, style || {});
    var baseBg = btn.style.background;
    var baseBorder = btn.style.border;
    var baseColor = btn.style.color;
    btn.addEventListener('mouseenter', function () {
      if (btn.disabled) return;
      if (baseBg === 'transparent' || baseBg === '') {
        btn.style.background = 'rgba(255,255,255,0.08)';
        btn.style.borderColor = '#666';
      } else {
        btn.style.filter = 'brightness(1.25)';
      }
      btn.style.transform = 'scale(1.08)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = baseBg;
      btn.style.border = baseBorder;
      btn.style.filter = '';
      btn.style.transform = '';
    });
    btn.addEventListener('mousedown', function () {
      if (btn.disabled) return;
      btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', function () {
      btn.style.transform = '';
    });
    return btn;
  }

  function buildDialogFooter(opts) {
    var row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    var td = opts.tooltipDelay != null ? opts.tooltipDelay : false;

    var hint = document.createElement('span');
    hint.textContent = opts.hint || '';
    Object.assign(hint.style, { color: '#555', fontSize: '11px', flex: '1' });
    row.appendChild(hint);

    var cancel = iconBtn(xSvg, { background: 'transparent', color: '#888', border: '1px solid #444' });
    attachHoverTooltip(cancel, opts.cancelTip || 'Cancel', td);
    cancel.onclick = opts.onCancel;
    row.appendChild(cancel);

    if (opts.onSendBack) {
      var back = iconBtn(sendBackSvg, { background: '#e67e22', color: '#fff' });
      attachHoverTooltip(back, opts.sendBackTip || 'Send to back', td);
      back.onclick = opts.onSendBack;
      row.appendChild(back);
    }

    if (opts.onDelete) {
      var del = iconBtn(trashSvg, { background: '#e63946', color: '#fff' });
      attachHoverTooltip(del, opts.deleteTip || 'Delete', td);
      del.onclick = opts.onDelete;
      row.appendChild(del);
    }

    var action = iconBtn(opts.actionIcon || plusSvg, { background: opts.actionColor || '#2a6bdb', color: '#fff' });
    attachHoverTooltip(action, opts.actionTip || 'Add', td);
    action.onclick = opts.onAction;
    row.appendChild(action);

    // Validation: disable action button and update tooltip when invalid
    var actionBaseTip = opts.actionTip || 'Add';
    var actionTipEl = null;
    function updateActionState() {
      var result = opts.validate ? opts.validate() : { valid: true };
      action.disabled = !result.valid;
      action.style.opacity = result.valid ? '1' : '0.35';
      action.style.cursor = result.valid ? 'pointer' : 'not-allowed';
      // Swap tooltip text when disabled
      if (actionTipEl) actionTipEl.remove();
      actionTipEl = null;
      attachHoverTooltip(action, result.valid ? actionBaseTip : (result.reason || actionBaseTip), td);
    }
    if (opts.validate) {
      updateActionState();
      if (opts.requireInput) {
        opts.requireInput.addEventListener('input', updateActionState);
      }
    }
    row.updateActionState = updateActionState;

    return row;
  }

  // Create annotation label: Rect background + Text, returns text fabric object
  function addAnnotationLabel(text, x, y, opts) {
    opts = opts || {};
    var pad = 10;
    var textObj = new fabric.Text(text, {
      left: x + pad, top: y + pad,
      fontSize: opts.fontSize || 13, fill: '#e63946',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: opts.fontWeight || 'normal',
      selectable: false, evented: false
    });
    // Use Fabric's own width/height — calculated in constructor, same system as rendering
    var bg = new fabric.Rect({
      left: x, top: y,
      width: textObj.width + pad * 2, height: textObj.height + pad * 2,
      fill: 'rgba(255,255,255,0.93)', rx: 4, ry: 4,
      selectable: false, evented: false, _isLabelBg: true
    });
    fabricCanvas.add(bg);
    fabricCanvas.add(textObj);
    return textObj;
  }

  function updateAnnotationLabel(annotationIndex, newText) {
    var pad = 10;
    var objs = fabricCanvas.getObjects();
    var textObj = objs.find(function (o) { return o._redlineIndex === annotationIndex && o.type === 'text'; });
    if (!textObj) return;
    textObj.set('text', newText);
    textObj.initDimensions();
    var bg = objs.find(function (o) { return o._redlineIndex === annotationIndex && o._isLabelBg; });
    if (bg) {
      bg.set({ left: textObj.left - pad, top: textObj.top - pad, width: textObj.width + pad * 2, height: textObj.height + pad * 2 });
    }
    fabricCanvas.renderAll();
  }

  function buildDialogTextarea(opts) {
    var textarea = document.createElement('textarea');
    textarea.rows = 7;
    textarea.placeholder = opts.placeholder || 'Describe the issue...';
    if (opts.value) textarea.value = opts.value;
    Object.assign(textarea.style, {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
      border: '1px solid #333', borderRadius: '8px', fontSize: '13px',
      background: '#0d0d1a', color: '#fff', resize: 'none',
      fontFamily: 'system-ui, sans-serif', lineHeight: '1.5', outline: 'none'
    });
    return textarea;
  }

  // --- Comment input popup (appears to the right with arrow pointing left) ---
  // opts.freehandSnapshot: if set, adds undo/redo stroke controls
  function showCommentInput(x, y, opts) {
    return new Promise((resolve) => {
      var arrowSize = 8;
      var popupW = 400;
      var popupLeft = x + 16;
      var arrowSide = 'left'; // arrow points left toward the element

      // If no room on the right, show on the left
      if (popupLeft + popupW > window.innerWidth - 10) {
        popupLeft = x - 16 - popupW;
        arrowSide = 'right';
      }

      const popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed', left: popupLeft + 'px',
        top: '-9999px', zIndex: '2147483647',
        background: '#1a1a2e', borderRadius: '12px', padding: '10px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        border: '1px solid #2a2a3e',
        display: 'flex', flexDirection: 'column', gap: '8px', width: '390px'
      });

      // CSS arrow
      var arrow = document.createElement('div');
      Object.assign(arrow.style, {
        position: 'absolute',
        top: '20px',
        width: '0', height: '0',
        borderTop: arrowSize + 'px solid transparent',
        borderBottom: arrowSize + 'px solid transparent'
      });
      if (arrowSide === 'left') {
        arrow.style.left = -arrowSize + 'px';
        arrow.style.borderRight = arrowSize + 'px solid #1a1a2e';
      } else {
        arrow.style.right = -arrowSize + 'px';
        arrow.style.borderLeft = arrowSize + 'px solid #1a1a2e';
      }
      popup.appendChild(arrow);

      var textarea = buildDialogTextarea({ placeholder: 'Describe the issue...' });

      var cleanupFns = [];
      function finish(val) {
        cleanupFns.forEach(function (fn) { fn(); });
        popup.remove();
        resolve(val);
      }

      var isFreehand = opts && opts.freehandSnapshot != null;
      var freehandSnap = isFreehand ? opts.freehandSnapshot : 0;
      var redoStack = [];

      var footer = buildDialogFooter({
        hint: isFreehand ? 'Draw and describe' : 'Describe and add',
        cancelTip: 'Cancel',
        actionTip: 'Add annotation',
        onCancel: function () { finish(null); },
        onAction: function () { finish(textarea.value.trim()); },
        requireInput: textarea,
        validate: function () {
          if (isFreehand) {
            var strokeCount = fabricCanvas.getObjects().length - freehandSnap;
            if (strokeCount === 0) return { valid: false, reason: 'Draw on the canvas first' };
          }
          if (!textarea.value.trim()) return { valid: false, reason: 'Enter a description first' };
          return { valid: true };
        }
      });

      // Freehand: undo/redo stroke row above textarea (like arrow/circle info rows)
      if (isFreehand) {
        var strokeRow = document.createElement('div');
        Object.assign(strokeRow.style, { display: 'flex', alignItems: 'center', gap: '4px' });

        var strokeInfo = document.createElement('span');
        Object.assign(strokeInfo.style, { flex: '1', fontSize: '11px', padding: '2px 6px', borderRadius: '4px' });

        var undoBtn = iconBtn(undoSvg, { background: 'transparent', color: '#aaa', border: '1px solid #333' });
        var redoBtn = iconBtn(redoSvg, { background: 'transparent', color: '#aaa', border: '1px solid #333' });
        attachHoverTooltip(undoBtn, 'Undo last stroke', 0);
        attachHoverTooltip(redoBtn, 'Redo stroke', 0);

        function updateStrokeUI() {
          var count = fabricCanvas.getObjects().length - freehandSnap;
          if (count === 0) {
            strokeInfo.textContent = 'Draw on the canvas';
            strokeInfo.style.color = '#e63946';
            strokeInfo.style.background = 'rgba(230,57,70,0.08)';
          } else {
            strokeInfo.textContent = count + ' stroke' + (count !== 1 ? 's' : '');
            strokeInfo.style.color = '#7cb3ff';
            strokeInfo.style.background = 'rgba(42,107,219,0.08)';
          }
          undoBtn.disabled = count === 0;
          undoBtn.style.opacity = count === 0 ? '0.35' : '1';
          undoBtn.style.cursor = count === 0 ? 'not-allowed' : 'pointer';
          redoBtn.disabled = redoStack.length === 0;
          redoBtn.style.opacity = redoStack.length === 0 ? '0.35' : '1';
          redoBtn.style.cursor = redoStack.length === 0 ? 'not-allowed' : 'pointer';
          footer.updateActionState();
        }

        undoBtn.addEventListener('click', function () {
          if (undoBtn.disabled) return;
          var objs = fabricCanvas.getObjects();
          if (objs.length <= freehandSnap) return;
          var last = objs[objs.length - 1];
          fabricCanvas.remove(last);
          redoStack.push(last);
          fabricCanvas.renderAll();
          updateStrokeUI();
        });

        redoBtn.addEventListener('click', function () {
          if (redoBtn.disabled) return;
          if (redoStack.length === 0) return;
          var stroke = redoStack.pop();
          fabricCanvas.add(stroke);
          fabricCanvas.renderAll();
          updateStrokeUI();
        });

        strokeRow.appendChild(strokeInfo);
        strokeRow.appendChild(undoBtn);
        strokeRow.appendChild(redoBtn);
        popup.appendChild(strokeRow);

        function onNewStroke() {
          redoStack = [];
          updateStrokeUI();
        }
        fabricCanvas.on('path:created', onNewStroke);
        cleanupFns.push(function () { fabricCanvas.off('path:created', onNewStroke); });

        updateStrokeUI();
      }

      popup.appendChild(textarea);
      popup.appendChild(footer);

      document.body.appendChild(popup);
      var popupTop = Math.max(10, Math.min(y - 24, window.innerHeight - popup.offsetHeight - 10));
      popup.style.top = popupTop + 'px';

      setTimeout(function () { textarea.focus(); }, 0);

      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
          e.preventDefault();
          finish(textarea.value.trim());
        }
        if (e.key === 'Escape') finish(null);
        if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(null);
        }
      });
    });
  }

  // --- Element highlight ---
  function highlightElement(el) {
    const rect = el.getBoundingClientRect();
    const highlight = new fabric.Rect({
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      fill: 'rgba(230, 57, 70, 0.15)', stroke: '#e63946', strokeWidth: 2,
      selectable: false, evented: false, hoverCursor: 'default'
    });
    fabricCanvas.add(highlight);
    return highlight;
  }

  // --- Create toolbar ---
  function createToolbar() {
    toolbarEl = document.createElement('div');
    Object.assign(toolbarEl.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', background: '#1a1a2e', borderRadius: '10px', padding: '6px 10px',
      display: 'flex', gap: '4px', alignItems: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      fontFamily: 'system-ui, sans-serif', cursor: 'grab', userSelect: 'none'
    });

    // Make toolbar draggable
    var dragState = null;
    toolbarEl.addEventListener('mousedown', function (e) {
      if (e.target.closest('button') || e.target.tagName === 'SPAN') return;
      dragState = {
        startX: e.clientX, startY: e.clientY,
        origLeft: toolbarEl.getBoundingClientRect().left,
        origTop: toolbarEl.getBoundingClientRect().top
      };
      toolbarEl.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      toolbarEl.style.left = (dragState.origLeft + dx) + 'px';
      toolbarEl.style.top = (dragState.origTop + dy) + 'px';
      toolbarEl.style.transform = 'none';
    });
    document.addEventListener('mouseup', function () {
      if (dragState) {
        dragState = null;
        toolbarEl.style.cursor = 'grab';
      }
    });

    // Drag handle grip
    var grip = document.createElement('div');
    grip.innerHTML = '<svg width="8" height="16" viewBox="0 0 8 16" fill="#555"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/><circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/><circle cx="2" cy="14" r="1.2"/><circle cx="6" cy="14" r="1.2"/></svg>';
    Object.assign(grip.style, { cursor: 'grab', padding: '0 4px 0 0', display: 'flex', alignItems: 'center', opacity: '0.6' });
    toolbarEl.appendChild(grip);

    var tools = [
      { id: 'select', label: pointerSvg + ' Select', tip: 'Click elements to annotate' },
      { id: 'arrow', label: '→ Arrow', tip: 'Draw arrows' },
      { id: 'circle', label: '○ Circle', tip: 'Draw circles and ellipses' },
      { id: 'box', label: '□ Box', tip: 'Draw rectangles' },
      { id: 'text', label: 'T Text', tip: 'Place text annotations' },
      { id: 'freehand', label: '✎ Draw', tip: 'Freehand drawing' },
      'divider',
      { id: 'edit', label: pencilSvg + ' Edit', tip: 'Select and edit existing annotations' }
    ];

    tools.forEach(function (tool) {
      if (tool === 'divider') {
        var div = document.createElement('div');
        Object.assign(div.style, { width: '1px', height: '20px', background: '#444', margin: '0 2px' });
        toolbarEl.appendChild(div);
        return;
      }
      var btn = document.createElement('button');
      btn.innerHTML = tool.label;
      btn.dataset.tool = tool.id;
      Object.assign(btn.style, {
        padding: '6px 12px', border: 'none', borderRadius: '6px', cursor: 'pointer',
        fontSize: '12px', fontWeight: '500', transition: 'background 0.15s',
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        background: tool.id === currentTool ? '#2a6bdb' : 'transparent',
        color: '#fff'
      });
      attachHoverTooltip(btn, tool.tip, false);
      btn.onclick = function () { setTool(tool.id); };
      toolbarEl.appendChild(btn);
    });

    // Annotation count
    var counter = document.createElement('span');
    counter.id = '__redline_counter';
    Object.assign(counter.style, {
      color: '#aaa', fontSize: '12px', marginLeft: '8px', padding: '0 8px',
      borderLeft: '1px solid #444'
    });
    counter.textContent = '0 annotations';
    toolbarEl.appendChild(counter);

    // Reset All button
    var resetSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
    var resetBtn = iconBtn(resetSvg, { background: '#e63946', color: '#fff', marginLeft: '4px' });
    attachHoverTooltip(resetBtn, 'Reset all — discard annotations and clear session', false);
    resetBtn.onclick = function () { resetAll(); };
    toolbarEl.appendChild(resetBtn);

    // Done button
    var checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    var doneBtn = iconBtn(checkSvg, { background: '#27ae60', color: '#fff', marginLeft: '4px' });
    attachHoverTooltip(doneBtn, 'Finish and save annotations', false);
    doneBtn.onclick = function () { deactivate(); };
    toolbarEl.appendChild(doneBtn);

    document.body.appendChild(toolbarEl);
  }

  function updateCounter() {
    var el = document.getElementById('__redline_counter');
    if (el) el.textContent = annotations.length + ' annotation' + (annotations.length !== 1 ? 's' : '');
  }

  function setTool(toolId) {
    currentTool = toolId;
    clearPendingSelect();
    clearPendingDraw();
    toolbarEl.querySelectorAll('button[data-tool]').forEach(function (btn) {
      btn.style.background = btn.dataset.tool === toolId ? '#2a6bdb' : 'transparent';
    });

    if (fabricCanvas) {
      fabricCanvas.isDrawingMode = (toolId === 'freehand');
      if (toolId === 'freehand') {
        fabricCanvas.freeDrawingBrush.color = '#e63946';
        fabricCanvas.freeDrawingBrush.width = 3;
      }
      var upperCanvas = fabricCanvas.upperCanvasEl || fabricCanvas.wrapperEl;
      upperCanvas.style.cursor = (toolId === 'edit' || toolId === 'select') ? 'default' : 'crosshair';
    }
  }

  // --- Create an arrowhead as a triangle at the end of a line ---
  function createArrowhead(fromX, fromY, toX, toY) {
    var angle = Math.atan2(toY - fromY, toX - fromX);
    var headLen = 14;
    var triangle = new fabric.Triangle({
      left: toX,
      top: toY,
      width: headLen,
      height: headLen,
      fill: '#e63946',
      angle: (angle * 180 / Math.PI) + 90,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false
    });
    return triangle;
  }

  // --- Pending draw state for arrows and shapes ---
  var pendingDraw = null;

  var DRAW_INTENTS = {
    arrow: [
      { value: 'points-to', icon: '→', tip: 'Points to — describe the target', placeholder: 'Describe what the arrow points to...' },
      { value: 'move', icon: '↔', tip: 'Move — from here to there', placeholder: 'Describe what to move and where...' },
      { value: 'connect', icon: '⟷', tip: 'Connect — relate two elements', placeholder: 'Describe the relationship...' }
    ],
    circle: [
      { value: 'highlight', icon: '◎', tip: 'Highlight — draw attention', placeholder: 'Describe the issue in this area...' },
      { value: 'remove', icon: '✕', tip: 'Remove — mark for deletion', placeholder: 'Describe what to remove...' },
      { value: 'resize', icon: '⤢', tip: 'Resize — change dimensions', placeholder: 'Describe the desired size change...' }
    ],
    box: [
      { value: 'highlight', icon: '▣', tip: 'Highlight — draw attention', placeholder: 'Describe the issue in this area...' },
      { value: 'remove', icon: '✕', tip: 'Remove — mark for deletion', placeholder: 'Describe what to remove...' },
      { value: 'resize', icon: '⤢', tip: 'Resize — change dimensions', placeholder: 'Describe the desired size change...' }
    ]
  };

  function showDrawBadge(type, startPoint, endPoint, initialSnapshotCount) {
    var badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'fixed', top: '56px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', background: '#1a1a2e', borderRadius: '12px',
      padding: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
      border: '1px solid #2a2a3e', fontFamily: 'system-ui, sans-serif',
      display: 'flex', flexDirection: 'column', gap: '10px', width: '400px'
    });

    var intents = DRAW_INTENTS[type] || DRAW_INTENTS.arrow;
    var selectedIntent = intents[0].value;

    // Hidden input to track selected value
    var intentInput = document.createElement('input');
    intentInput.type = 'hidden';
    intentInput.dataset.drawIntent = '1';
    intentInput.value = selectedIntent;
    badge.appendChild(intentInput);

    // Top row: position info (left) + segmented intent toggle (right)
    var topRow = document.createElement('div');
    Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    var info = document.createElement('div');
    info.dataset.drawInfo = '1';
    Object.assign(info.style, {
      color: '#7cb3ff', fontSize: '11px', fontFamily: 'monospace',
      padding: '4px 8px', background: 'rgba(42,107,219,0.08)', borderRadius: '4px',
      wordBreak: 'break-all', flex: '1', minWidth: '0'
    });
    updateDrawInfoText(info, type, selectedIntent, startPoint, endPoint);
    topRow.appendChild(info);

    var intentToggle = document.createElement('div');
    Object.assign(intentToggle.style, {
      display: 'flex', gap: '0', background: '#0d0d1a', borderRadius: '6px',
      padding: '2px', border: '1px solid #333', flexShrink: '0'
    });

    var intentButtons = [];
    intents.forEach(function (opt, idx) {
      var seg = document.createElement('button');
      seg.textContent = opt.icon;
      Object.assign(seg.style, {
        padding: '5px 10px', border: 'none', borderRadius: '4px',
        fontSize: '16px', cursor: 'pointer', transition: 'all 0.15s',
        background: idx === 0 ? '#2a6bdb' : 'transparent',
        color: idx === 0 ? '#fff' : '#666', lineHeight: '1'
      });
      attachHoverTooltip(seg, opt.tip, false);
      seg.onclick = function () {
        intentButtons.forEach(function (b) {
          b.style.background = 'transparent';
          b.style.color = '#666';
        });
        seg.style.background = '#2a6bdb';
        seg.style.color = '#fff';
        selectedIntent = opt.value;
        intentInput.value = opt.value;
        textarea.placeholder = opt.placeholder;
        if (pendingDraw) {
          updateDrawInfoText(info, pendingDraw.type, opt.value, pendingDraw.startPoint, pendingDraw.endPoint);
        }
      };
      intentButtons.push(seg);
      intentToggle.appendChild(seg);
    });
    topRow.appendChild(intentToggle);
    badge.appendChild(topRow);

    var textarea = buildDialogTextarea({ placeholder: intents[0].placeholder });
    badge.appendChild(textarea);

    var footer = buildDialogFooter({
      hint: 'Drag to redraw',
      cancelTip: 'Cancel — discard drawing',
      actionTip: 'Add annotation',
      onCancel: clearPendingDraw,
      onAction: submitPendingDraw,
      requireInput: textarea,
      validate: function () {
        var snap = pendingDraw ? pendingDraw.snapshotCount : initialSnapshotCount;
        var hasDrawing = fabricCanvas.getObjects().length > snap;
        if (!hasDrawing) {
          info.textContent = 'Draw ' + (type === 'arrow' ? 'an' : 'a') + ' ' + type + ' on the canvas';
          info.style.color = '#e63946';
          info.style.background = 'rgba(230,57,70,0.08)';
        } else {
          info.style.color = '#7cb3ff';
          info.style.background = 'rgba(42,107,219,0.08)';
        }
        if (!hasDrawing) return { valid: false, reason: 'Draw ' + (type === 'arrow' ? 'an' : 'a') + ' ' + type + ' first' };
        if (!textarea.value.trim()) return { valid: false, reason: 'Enter a description first' };
        return { valid: true };
      }
    });
    badge.appendChild(footer);

    badge._updateActionState = footer.updateActionState;

    document.body.appendChild(badge);
    setTimeout(function () { textarea.focus(); }, 0);

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPendingDraw(); }
      if (e.key === 'Escape') clearPendingDraw();
      if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        clearPendingDraw();
      }
    });

    return badge;
  }

  function updateDrawInfoText(el, type, intent, startPoint, endPoint) {
    var from = '(' + Math.round(startPoint.x) + ', ' + Math.round(startPoint.y) + ')';
    var to = '(' + Math.round(endPoint.x) + ', ' + Math.round(endPoint.y) + ')';
    if (type === 'arrow') {
      if (intent === 'move') {
        el.textContent = 'Move: ' + from + ' \u2192 ' + to;
      } else if (intent === 'connect') {
        el.textContent = 'Connect: ' + from + ' \u2194 ' + to;
      } else {
        el.textContent = 'Points to: ' + to;
      }
    } else {
      var cx = Math.round((startPoint.x + endPoint.x) / 2);
      var cy = Math.round((startPoint.y + endPoint.y) / 2);
      var label = type === 'circle' ? 'Circle' : 'Box';
      if (intent === 'remove') {
        el.textContent = 'Remove at (' + cx + ', ' + cy + ')';
      } else if (intent === 'resize') {
        el.textContent = 'Resize at (' + cx + ', ' + cy + ')';
      } else {
        el.textContent = label + ' at (' + cx + ', ' + cy + ')';
      }
    }
  }

  function submitPendingDraw() {
    if (!pendingDraw) return;

    var textarea = pendingDraw.badgeEl.querySelector('textarea');
    var comment = textarea ? textarea.value.trim() : '';
    if (!comment) return;

    var intentSelect = pendingDraw.badgeEl.querySelector('[data-draw-intent]');
    var intent = intentSelect ? intentSelect.value : 'points-to';

    var pd = pendingDraw;

    // Capture near-element at the relevant point(s)
    var fromElement = getElementUnderPoint(pd.startPoint.x, pd.startPoint.y);
    var cx = pd.type === 'arrow' ? pd.endPoint.x : (pd.startPoint.x + pd.endPoint.x) / 2;
    var cy = pd.type === 'arrow' ? pd.endPoint.y : (pd.startPoint.y + pd.endPoint.y) / 2;
    var toElement = getElementUnderPoint(cx, cy);

    var labelX = pd.type === 'arrow' ? pd.endPoint.x + 8 : Math.max(pd.startPoint.x, pd.endPoint.x) + 8;
    var labelY = pd.type === 'arrow' ? pd.endPoint.y - 10 : Math.min(pd.startPoint.y, pd.endPoint.y);
    addAnnotationLabel(comment, labelX, labelY);
    fabricCanvas.renderAll();

    var toSnapshot = toElement ? getComputedSnapshot(toElement) : null;
    var annotationData = {
      type: pd.type === 'arrow' ? 'arrow' : (pd.type === 'circle' ? 'circle' : 'box'),
      intent: intent,
      comment: comment,
      from: { x: Math.round(pd.startPoint.x), y: Math.round(pd.startPoint.y) },
      to: { x: Math.round(pd.endPoint.x), y: Math.round(pd.endPoint.y) },
      nearSelector: toElement ? getCssSelector(toElement) : null,
      nearTagName: toElement ? toElement.tagName : null,
      nearClasses: toElement ? (toElement.className || '') : null,
      computedCss: toSnapshot ? toSnapshot.computedCss : null,
      html: toSnapshot ? toSnapshot.html : null,
      childHints: toSnapshot ? toSnapshot.childHints : null
    };

    // For move/connect intents, also capture the source element
    if ((intent === 'move' || intent === 'connect') && fromElement) {
      annotationData.fromSelector = getCssSelector(fromElement);
      annotationData.fromTagName = fromElement.tagName;
      annotationData.fromClasses = fromElement.className || '';
    }

    annotations.push(annotationData);
    annotationObjects.push({ snapshotCount: pd.snapshotCount });
    tagCanvasObjects(annotations.length - 1, pd.snapshotCount);
    updateCounter();
    persistSession();

    pd.badgeEl.remove();
    pendingDraw = null;
  }

  function clearPendingDraw() {
    if (!pendingDraw) return;
    var toRemove = fabricCanvas.getObjects().slice(pendingDraw.snapshotCount);
    toRemove.forEach(function (o) { fabricCanvas.remove(o); });
    fabricCanvas.renderAll();
    if (pendingDraw.badgeEl) pendingDraw.badgeEl.remove();
    pendingDraw = null;
  }

  function setupCanvasDrawing() {
    var isDrawingShape = false;
    var shapeStart = null;
    var tempShapes = []; // may be multiple objects (line + arrowhead)
    var shapeSnapshotCount = 0; // canvas object count before drawing started

    function removeTempShapes() {
      tempShapes.forEach(function (s) { fabricCanvas.remove(s); });
      tempShapes = [];
    }

    fabricCanvas.on('mouse:down', function (opt) {
      if (currentTool === 'select') {
        handleElementClick(opt.e);
        return;
      }
      if (currentTool === 'edit') {
        handleEditClick(opt.e);
        return;
      }
      if (currentTool === 'freehand') return;
      if (currentTool === 'text') {
        handleTextPlace(opt.e);
        return;
      }
      // If redrawing while pending draw badge is open, clear old shape objects
      if (pendingDraw) {
        var toRemove = fabricCanvas.getObjects().slice(pendingDraw.snapshotCount);
        toRemove.forEach(function (o) { fabricCanvas.remove(o); });
        fabricCanvas.renderAll();
        pendingDraw.snapshotCount = fabricCanvas.getObjects().length;
        if (pendingDraw.badgeEl && pendingDraw.badgeEl._updateActionState) {
          pendingDraw.badgeEl._updateActionState();
        }
      }
      isDrawingShape = true;
      shapeSnapshotCount = fabricCanvas.getObjects().length;
      var pointer = fabricCanvas.getPointer(opt.e);
      shapeStart = { x: pointer.x, y: pointer.y };
    });

    fabricCanvas.on('mouse:move', function (opt) {
      if (!isDrawingShape || !shapeStart) return;
      var pointer = fabricCanvas.getPointer(opt.e);
      removeTempShapes();

      if (currentTool === 'arrow') {
        var line = new fabric.Line(
          [shapeStart.x, shapeStart.y, pointer.x, pointer.y],
          { stroke: '#e63946', strokeWidth: 3, selectable: false, evented: false }
        );
        var head = createArrowhead(shapeStart.x, shapeStart.y, pointer.x, pointer.y);
        tempShapes = [line, head];
        fabricCanvas.add(line);
        fabricCanvas.add(head);
      } else if (currentTool === 'circle' || currentTool === 'box') {
        var shape;
        if (currentTool === 'circle') {
          var rx = Math.abs(pointer.x - shapeStart.x) / 2;
          var ry = Math.abs(pointer.y - shapeStart.y) / 2;
          shape = new fabric.Ellipse({
            left: Math.min(shapeStart.x, pointer.x), top: Math.min(shapeStart.y, pointer.y),
            rx: rx, ry: ry, fill: 'rgba(230,57,70,0.1)', stroke: '#e63946', strokeWidth: 2,
            selectable: false, evented: false
          });
        } else {
          shape = new fabric.Rect({
            left: Math.min(shapeStart.x, pointer.x), top: Math.min(shapeStart.y, pointer.y),
            width: Math.abs(pointer.x - shapeStart.x), height: Math.abs(pointer.y - shapeStart.y),
            fill: 'rgba(230,57,70,0.1)', stroke: '#e63946', strokeWidth: 2,
            selectable: false, evented: false
          });
        }
        tempShapes = [shape];
        fabricCanvas.add(shape);
      }
    });

    fabricCanvas.on('mouse:up', function (opt) {
      if (!isDrawingShape || !shapeStart) {
        isDrawingShape = false;
        shapeStart = null;
        tempShapes = [];
        return;
      }
      var pointer = fabricCanvas.getPointer(opt.e);
      var dx = Math.abs(pointer.x - shapeStart.x);
      var dy = Math.abs(pointer.y - shapeStart.y);

      isDrawingShape = false;
      var savedStart = { x: shapeStart.x, y: shapeStart.y };
      shapeStart = null;
      tempShapes = [];

      if (dx > 5 || dy > 5) {
        var type = currentTool;

        if (pendingDraw) {
          // Redraw: update pending state and badge info
          pendingDraw.type = type;
          pendingDraw.startPoint = savedStart;
          pendingDraw.endPoint = { x: pointer.x, y: pointer.y };
          var infoEl = pendingDraw.badgeEl.querySelector('[data-draw-info]');
          var intentSel = pendingDraw.badgeEl.querySelector('[data-draw-intent]');
          var curIntent = intentSel ? intentSel.value : 'points-to';
          if (infoEl) updateDrawInfoText(infoEl, type, curIntent, savedStart, { x: pointer.x, y: pointer.y });
          if (pendingDraw.badgeEl && pendingDraw.badgeEl._updateActionState) {
            pendingDraw.badgeEl._updateActionState();
          }
        } else {
          // First draw: create pending state with badge
          var badgeEl = showDrawBadge(type, savedStart, { x: pointer.x, y: pointer.y }, shapeSnapshotCount);
          pendingDraw = {
            type: type,
            startPoint: savedStart,
            endPoint: { x: pointer.x, y: pointer.y },
            snapshotCount: shapeSnapshotCount,
            badgeEl: badgeEl
          };
        }
      }
    });

    // Track freehand paths — show comment popup after first stroke, user can keep drawing
    var freehandSnapshot = null;
    var freehandPopupActive = false;

    async function startFreehandAnnotation() {
      if (freehandPopupActive) return;
      freehandPopupActive = true;

      var snap = freehandSnapshot;

      // Position popup near the first stroke
      var paths = fabricCanvas.getObjects().slice(snap);
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      paths.forEach(function (p) {
        var b = p.getBoundingRect();
        if (b.left < minX) minX = b.left;
        if (b.top < minY) minY = b.top;
        if (b.left + b.width > maxX) maxX = b.left + b.width;
        if (b.top + b.height > maxY) maxY = b.top + b.height;
      });

      // Show popup — drawing mode stays on so user can keep drawing
      var comment = await showCommentInput(maxX, minY, { freehandSnapshot: snap });

      freehandPopupActive = false;

      // Gather ALL strokes (including ones drawn while popup was open)
      var allPaths = fabricCanvas.getObjects().slice(snap);
      var fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
      allPaths.forEach(function (p) {
        var b = p.getBoundingRect();
        if (b.left < fMinX) fMinX = b.left;
        if (b.top < fMinY) fMinY = b.top;
        if (b.left + b.width > fMaxX) fMaxX = b.left + b.width;
        if (b.top + b.height > fMaxY) fMaxY = b.top + b.height;
      });

      if (!comment) {
        allPaths.forEach(function (o) { fabricCanvas.remove(o); });
        fabricCanvas.renderAll();
        freehandSnapshot = null;
        return;
      }

      var cx = (fMinX + fMaxX) / 2;
      var cy = (fMinY + fMaxY) / 2;
      var nearElement = getElementUnderPoint(cx, cy);
      var nearSelector = nearElement ? getCssSelector(nearElement) : null;

      addAnnotationLabel(comment, fMaxX + 8, fMinY);
      fabricCanvas.renderAll();

      var nearSnapshot = nearElement ? getComputedSnapshot(nearElement) : null;
      annotations.push({
        type: 'freehand',
        comment: comment,
        nearSelector: nearSelector,
        nearTagName: nearElement ? nearElement.tagName : null,
        nearClasses: nearElement ? (nearElement.className || '') : null,
        computedCss: nearSnapshot ? nearSnapshot.computedCss : null,
        html: nearSnapshot ? nearSnapshot.html : null,
        childHints: nearSnapshot ? nearSnapshot.childHints : null
      });
      annotationObjects.push({ snapshotCount: snap });
      tagCanvasObjects(annotations.length - 1, snap);
      updateCounter();
      persistSession();
      freehandSnapshot = null;
    }

    fabricCanvas.on('path:created', function () {
      if (freehandSnapshot == null) {
        freehandSnapshot = fabricCanvas.getObjects().length - 1;
      }
      startFreehandAnnotation();
    });
  }

  // --- Handle text placement ---
  async function handleTextPlace(e) {
    if (isSelectBusy) return;
    isSelectBusy = true;

    var x = e.clientX;
    var y = e.clientY;
    var pointer = fabricCanvas.getPointer(e);

    var comment = await showCommentInput(x, y);
    if (!comment) {
      isSelectBusy = false;
      return;
    }

    var nearElement = getElementUnderPoint(x, y);
    var nearSelector = nearElement ? getCssSelector(nearElement) : null;

    var textSnap = fabricCanvas.getObjects().length;
    addAnnotationLabel(comment, pointer.x, pointer.y, { fontSize: 15, fontWeight: 'bold' });
    fabricCanvas.renderAll();

    var nearSnapshot = nearElement ? getComputedSnapshot(nearElement) : null;
    annotations.push({
      type: 'text',
      comment: comment,
      position: { x: Math.round(pointer.x), y: Math.round(pointer.y) },
      nearSelector: nearSelector,
      nearTagName: nearElement ? nearElement.tagName : null,
      nearClasses: nearElement ? (nearElement.className || '') : null,
      computedCss: nearSnapshot ? nearSnapshot.computedCss : null,
      html: nearSnapshot ? nearSnapshot.html : null,
      childHints: nearSnapshot ? nearSnapshot.childHints : null
    });
    annotationObjects.push({ snapshotCount: textSnap });
    tagCanvasObjects(annotations.length - 1, textSnap);
    updateCounter();
    persistSession();
    isSelectBusy = false;
  }

  // --- Find element underneath the Fabric canvas ---
  function getElementUnderPoint(x, y) {
    // Hide ALL redline layers so elementFromPoint sees through to the app
    var canvasWrapper = fabricCanvas.wrapperEl;
    var prevWrapper = canvasWrapper.style.pointerEvents;
    var prevToolbar = toolbarEl ? toolbarEl.style.pointerEvents : null;
    canvasWrapper.style.pointerEvents = 'none';
    if (toolbarEl) toolbarEl.style.pointerEvents = 'none';

    var element = document.elementFromPoint(x, y);

    canvasWrapper.style.pointerEvents = prevWrapper;
    if (toolbarEl) toolbarEl.style.pointerEvents = prevToolbar;

    return element;
  }

  // --- Pending selection helpers (DOM traversal on repeated clicks) ---
  function clearPendingSelect() {
    if (!pendingSelect) return;
    if (pendingSelect.highlight) fabricCanvas.remove(pendingSelect.highlight);
    if (pendingSelect.badgeEl) pendingSelect.badgeEl.remove();
    activeTooltips.forEach(function (t) { if (t.parentNode) t.remove(); });
    activeTooltips = [];
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    pendingSelect = null;
  }

  // --- Hover tooltip — searchable or plain (0.75s delay for plain, instant for searchable) ---
  function attachHoverTooltip(triggerEl, content, searchableOrDelay) {
    // Clean up previous tooltip listeners on this element to prevent duplicates
    if (triggerEl._redlineTooltipCleanup) triggerEl._redlineTooltipCleanup();
    var tip = null;
    var hideTimeout = null;
    var showTimeout = null;
    var delay = typeof searchableOrDelay === 'number' ? searchableOrDelay : (searchableOrDelay ? 300 : 750);
    function showTip() {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      if (tip) return;
      tip = document.createElement('div');
      var isPlain = !searchableOrDelay || typeof searchableOrDelay === 'number';
      Object.assign(tip.style, {
        position: 'fixed', zIndex: '2147483647',
        background: '#0d0d1a', border: '1px solid #444', borderRadius: isPlain ? '6px' : '8px',
        padding: isPlain ? '6px 10px' : '10px 12px',
        maxWidth: isPlain ? '260px' : '480px',
        maxHeight: isPlain ? 'none' : '320px',
        overflow: isPlain ? 'visible' : 'auto',
        fontFamily: isPlain ? 'system-ui, sans-serif' : 'monospace',
        fontSize: isPlain ? '12px' : '11px', lineHeight: '1.5', color: '#ccc',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
      });
      if (!isPlain) {
        tip.innerHTML =
          '<input type="text" placeholder="Search..." style="width:100%;padding:4px 8px;margin-bottom:8px;border:1px solid #444;border-radius:4px;font-size:11px;background:#1a1a2e;color:#fff;font-family:monospace;box-sizing:border-box;" />' +
          '<div data-content style="white-space:pre-wrap;word-break:break-all;"></div>';
        var contentEl = tip.querySelector('[data-content]');
        var searchInput = tip.querySelector('input');
        contentEl.textContent = content;
        searchInput.addEventListener('input', function () {
          var query = searchInput.value.toLowerCase();
          if (!query) {
            contentEl.innerHTML = '';
            contentEl.textContent = content;
            return;
          }
          var lines = content.split('\n');
          contentEl.innerHTML = lines.map(function (line) {
            var idx = line.toLowerCase().indexOf(query);
            if (idx === -1) return '<div style="opacity:0.3;">' + escapeHtml(line) + '</div>';
            var before = escapeHtml(line.substring(0, idx));
            var match = escapeHtml(line.substring(idx, idx + query.length));
            var after = escapeHtml(line.substring(idx + query.length));
            return '<div>' + before + '<span style="background:#e63946;color:#fff;border-radius:2px;padding:0 2px;">' + match + '</span>' + after + '</div>';
          }).join('');
        });
        searchInput.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
      } else {
        tip.textContent = content;
      }
      tip.addEventListener('mouseenter', function () {
        if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      });
      tip.addEventListener('mouseleave', scheduleDismiss);
      document.body.appendChild(tip);
      activeTooltips.push(tip);
      var triggerRect = triggerEl.getBoundingClientRect();
      var tipW = tip.offsetWidth;
      var tipH = tip.offsetHeight;
      // Center horizontally on the trigger, clamp to viewport
      var tipLeft = triggerRect.left + triggerRect.width / 2 - tipW / 2;
      tipLeft = Math.max(8, Math.min(tipLeft, window.innerWidth - tipW - 8));
      // Prefer below, fall back to above
      var tipTop = triggerRect.bottom + 6;
      if (tipTop + tipH > window.innerHeight - 8) {
        tipTop = triggerRect.top - 6 - tipH;
      }
      tipTop = Math.max(8, tipTop);
      tip.style.left = tipLeft + 'px';
      tip.style.top = tipTop + 'px';
    }
    function scheduleDismiss() {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(function () {
        if (tip) { tip.remove(); tip = null; }
        hideTimeout = null;
      }, 150);
    }
    function onEnter() {
      if (delay > 0) {
        showTimeout = setTimeout(showTip, delay);
      } else {
        showTip();
      }
    }
    function onLeave() {
      if (showTimeout) { clearTimeout(showTimeout); showTimeout = null; }
      scheduleDismiss();
    }
    triggerEl.addEventListener('mouseenter', onEnter);
    triggerEl.addEventListener('mouseleave', onLeave);
    triggerEl._redlineTooltipCleanup = function () {
      triggerEl.removeEventListener('mouseenter', onEnter);
      triggerEl.removeEventListener('mouseleave', onLeave);
      if (showTimeout) { clearTimeout(showTimeout); showTimeout = null; }
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      if (tip) { tip.remove(); tip = null; }
    };
  }

  function showSelectionBadge(element) {
    // Preserve existing comment text when navigating up/down
    var existingText = '';
    // Dismiss all active tooltips
    activeTooltips.forEach(function (t) { if (t.parentNode) t.remove(); });
    activeTooltips = [];
    if (pendingSelect && pendingSelect.badgeEl) {
      var existingTextarea = pendingSelect.badgeEl.querySelector('textarea');
      if (existingTextarea) existingText = existingTextarea.value;
      pendingSelect.badgeEl.remove();
    } else if (pendingSelect && pendingSelect.editComment) {
      existingText = pendingSelect.editComment;
      pendingSelect.editComment = null; // only use once for initial load
    }

    var rect = element.getBoundingClientRect();
    var badge = document.createElement('div');
    var badgeW = 540;
    var gap = 10;

    Object.assign(badge.style, {
      position: 'fixed',
      left: '-9999px', top: '-9999px',
      width: badgeW + 'px',
      zIndex: '2147483647',
      background: '#1a1a2e', borderRadius: '12px', padding: '12px 14px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
      border: '1px solid #2a2a3e',
      fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#aaa'
    });
    var tagDisplay = element.tagName.toLowerCase();
    var classHint = element.className && typeof element.className === 'string'
      ? '.' + element.className.trim().split(/\s+/).join('.')
      : '';
    var selectorDisplay = tagDisplay + classHint;
    var isEditing = pendingSelect && pendingSelect.editIndex != null;
    var canGoUp = element.parentElement && element.parentElement !== document.body && element.parentElement !== document.documentElement;
    var canGoDown = !!findChildAtCenter(element);
    var canGoLeft = !!element.previousElementSibling;
    var canGoRight = !!element.nextElementSibling;
    function navBtnStyle(enabled) {
      return 'padding:4px 10px;border:none;border-radius:5px;background:#2a2a3e;color:' + (enabled ? '#ccc' : '#555') + ';cursor:' + (enabled ? 'pointer' : 'default') + ';font-size:13px;';
    }
    badge.innerHTML =
      '<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;">' +
        '<span style="color:#7cb3ff;font-weight:600;flex:1;font-size:13px;line-height:1.4;word-break:break-all;">' + selectorDisplay + '</span>' +
        '<div style="display:grid;grid-template-columns:28px 28px 28px;grid-template-rows:28px 28px;gap:2px;flex-shrink:0;">' +
          '<div></div>' +
          '<button data-action="parent" style="' + navBtnStyle(canGoUp) + 'padding:0;text-align:center;">↑</button>' +
          '<div></div>' +
          '<button data-action="prev" style="' + navBtnStyle(canGoLeft) + 'padding:0;text-align:center;">←</button>' +
          '<button data-action="child" style="' + navBtnStyle(canGoDown) + 'padding:0;text-align:center;">↓</button>' +
          '<button data-action="next" style="' + navBtnStyle(canGoRight) + 'padding:0;text-align:center;">→</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
        '<span data-action="show-html" style="padding:3px 8px;border-radius:4px;background:rgba(42,107,219,0.08);color:#7cb3ff;cursor:pointer;font-size:10px;font-family:monospace;font-weight:500;">HTML</span>' +
        '<span data-action="show-css" style="padding:3px 8px;border-radius:4px;background:rgba(42,107,219,0.08);color:#7cb3ff;cursor:pointer;font-size:10px;font-family:monospace;font-weight:500;">CSS</span>' +
      '</div>' +
      '<div data-role="textarea-placeholder"></div>' +
      '<div data-role="footer-placeholder"></div>';

    // Build textarea with shared helper
    var textarea = buildDialogTextarea({ placeholder: 'Describe the issue...', value: existingText });
    var textareaPlaceholder = badge.querySelector('[data-role="textarea-placeholder"]');
    textareaPlaceholder.parentNode.replaceChild(textarea, textareaPlaceholder);

    setTimeout(function () { textarea.focus(); }, 0);

    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey) {
        ev.preventDefault();
        submitPendingSelect();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        clearPendingSelect();
      }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        if (isEditing) removePendingAnnotation();
        else clearPendingSelect();
      }
    });

    badge.querySelector('[data-action="prev"]').onclick = function (ev) {
      ev.stopPropagation();
      if (element.previousElementSibling) navigatePending(element.previousElementSibling);
    };
    badge.querySelector('[data-action="child"]').onclick = function (ev) {
      ev.stopPropagation();
      var child = findChildAtCenter(element);
      if (child) navigatePending(child);
    };
    badge.querySelector('[data-action="parent"]').onclick = function (ev) {
      ev.stopPropagation();
      var parent = element.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) navigatePending(parent);
    };
    badge.querySelector('[data-action="next"]').onclick = function (ev) {
      ev.stopPropagation();
      if (element.nextElementSibling) navigatePending(element.nextElementSibling);
    };
    // Build footer with shared helper
    var footerOpts = {
      hint: 'Describe and add',
      cancelTip: 'Cancel — dismiss selection',
      actionTip: isEditing ? 'Update annotation' : 'Add annotation',
      actionIcon: isEditing ? pencilSvg : plusSvg,
      onCancel: function () { clearPendingSelect(); },
      onAction: function () { submitPendingSelect(); },
      requireInput: textarea,
      validate: function () {
        if (!textarea.value.trim()) return { valid: false, reason: 'Enter a description first' };
        return { valid: true };
      }
    };
    if (isEditing) {
      footerOpts.onSendBack = function () { sendBackPendingAnnotation(); };
      footerOpts.sendBackTip = 'Send to back — reveal annotations behind';
      footerOpts.onDelete = function () { removePendingAnnotation(); };
      footerOpts.deleteTip = 'Remove annotation';
    }
    var footerPlaceholder = badge.querySelector('[data-role="footer-placeholder"]');
    footerPlaceholder.parentNode.replaceChild(buildDialogFooter(footerOpts), footerPlaceholder);

    // Append and measure actual height, then position to fit in viewport
    document.body.appendChild(badge);
    var badgeH = badge.offsetHeight;
    var badgeLeft = Math.max(gap, Math.min(rect.left, window.innerWidth - badgeW - gap));
    var badgeTop;
    if (rect.bottom + gap + badgeH < window.innerHeight) {
      badgeTop = rect.bottom + gap;
    } else if (rect.top - gap - badgeH > 0) {
      badgeTop = rect.top - gap - badgeH;
    } else if (rect.right + gap + badgeW < window.innerWidth) {
      badgeLeft = rect.right + gap;
      badgeTop = Math.max(gap, Math.min(rect.top, window.innerHeight - badgeH - gap));
    } else {
      badgeTop = Math.max(gap, window.innerHeight - badgeH - gap);
    }
    badge.style.left = badgeLeft + 'px';
    badge.style.top = badgeTop + 'px';

    // HTML/CSS searchable tooltips
    var snapshot = getComputedSnapshot(element);
    var htmlContent = snapshot.html;
    if (snapshot.childHints.length > 0) {
      htmlContent += '\n\nChildren:\n' + snapshot.childHints.join('\n');
    }
    var cssContent = Object.keys(snapshot.computedCss).map(function (k) {
      return k + ': ' + snapshot.computedCss[k] + ';';
    }).join('\n');
    attachHoverTooltip(badge.querySelector('[data-action="show-html"]'), htmlContent || '(empty)', true);
    attachHoverTooltip(badge.querySelector('[data-action="show-css"]'), cssContent || '(no computed styles)', true);

    // Navigation tooltips
    attachHoverTooltip(badge.querySelector('[data-action="parent"]'), '↑ Parent element\nMove selection to the parent container', false);
    attachHoverTooltip(badge.querySelector('[data-action="child"]'), '↓ Child element\nDrill into the child at the center of this element', false);
    attachHoverTooltip(badge.querySelector('[data-action="prev"]'), '← Previous sibling\nSelect the previous element at the same level', false);
    attachHoverTooltip(badge.querySelector('[data-action="next"]'), '→ Next sibling\nSelect the next element at the same level', false);

    if (pendingSelect) pendingSelect.badgeEl = badge;
  }

  // Find the direct child of `el` that's visually at its center
  function findChildAtCenter(el) {
    if (!el.firstElementChild) return null;
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    // Use elementFromPoint to find the deepest element at center
    var deepest = getElementUnderPoint(cx, cy);
    if (!deepest || deepest === el) {
      // elementFromPoint didn't help — fall back to firstElementChild
      return el.firstElementChild;
    }
    // Walk up from deepest to find the direct child of `el`
    var current = deepest;
    while (current && current.parentElement !== el) {
      current = current.parentElement;
    }
    return current || el.firstElementChild;
  }

  function navigatePending(target) {
    if (!pendingSelect || !target) return;
    fabricCanvas.remove(pendingSelect.highlight);
    pendingSelect.element = target;
    pendingSelect.highlight = highlightElement(target);
    showSelectionBadge(target);
    fabricCanvas.renderAll();
  }

  // --- Tag fabric objects with annotation index ---
  function tagCanvasObjects(annotationIndex, fromObjectIndex) {
    var objects = fabricCanvas.getObjects();
    for (var i = fromObjectIndex; i < objects.length; i++) {
      objects[i]._redlineIndex = annotationIndex;
    }
  }

  // --- Find annotation at canvas coordinates ---
  function findAnnotationAtPoint(x, y) {
    var objects = fabricCanvas.getObjects();
    for (var i = objects.length - 1; i >= 0; i--) {
      var obj = objects[i];
      if (obj._redlineIndex == null) continue;
      var b = obj.getBoundingRect();
      if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
        return obj._redlineIndex;
      }
    }
    return null;
  }

  // --- Edit existing annotation popup ---
  function showEditPopup(x, y, annotationIndex) {
    return new Promise(function (resolve) {
      var ann = annotations[annotationIndex];
      var isDrawType = ann.type === 'arrow' || ann.type === 'circle' || ann.type === 'box';
      var isFreehand = ann.type === 'freehand';
      var popupW = 400;
      var popupLeft = x + 16;

      if (popupLeft + popupW > window.innerWidth - 10) {
        popupLeft = x - 16 - popupW;
      }

      var popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed', left: popupLeft + 'px', top: '-9999px',
        width: '390px', zIndex: '2147483647', background: '#1a1a2e', borderRadius: '12px',
        padding: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        border: '1px solid #2a2a3e', display: 'flex', flexDirection: 'column', gap: '8px'
      });

      var selectedIntent = ann.intent || null;
      var defaultPlaceholder = 'Edit comment...';

      if (isDrawType) {
        // Draw types: same UI as creation badge (info row + intent toggle)
        var intents = DRAW_INTENTS[ann.type] || DRAW_INTENTS.arrow;
        var startPoint = ann.from || { x: 0, y: 0 };
        var endPoint = ann.to || { x: 0, y: 0 };
        if (!selectedIntent) selectedIntent = intents[0].value;

        var topRow = document.createElement('div');
        Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        var info = document.createElement('div');
        Object.assign(info.style, {
          color: '#7cb3ff', fontSize: '11px', fontFamily: 'monospace',
          padding: '4px 8px', background: 'rgba(42,107,219,0.08)', borderRadius: '4px',
          wordBreak: 'break-all', flex: '1', minWidth: '0'
        });
        updateDrawInfoText(info, ann.type, selectedIntent, startPoint, endPoint);
        topRow.appendChild(info);

        var intentToggle = document.createElement('div');
        Object.assign(intentToggle.style, {
          display: 'flex', gap: '0', background: '#0d0d1a', borderRadius: '6px',
          padding: '2px', border: '1px solid #333', flexShrink: '0'
        });

        var intentButtons = [];
        intents.forEach(function (opt) {
          var isActive = opt.value === selectedIntent;
          var seg = document.createElement('button');
          seg.textContent = opt.icon;
          Object.assign(seg.style, {
            padding: '5px 10px', border: 'none', borderRadius: '4px',
            fontSize: '16px', cursor: 'pointer', transition: 'all 0.15s',
            background: isActive ? '#2a6bdb' : 'transparent',
            color: isActive ? '#fff' : '#666', lineHeight: '1'
          });
          attachHoverTooltip(seg, opt.tip, false);
          seg.onclick = function () {
            intentButtons.forEach(function (b) {
              b.style.background = 'transparent';
              b.style.color = '#666';
            });
            seg.style.background = '#2a6bdb';
            seg.style.color = '#fff';
            selectedIntent = opt.value;
            textarea.placeholder = opt.placeholder;
            updateDrawInfoText(info, ann.type, opt.value, startPoint, endPoint);
          };
          intentButtons.push(seg);
          intentToggle.appendChild(seg);
        });
        topRow.appendChild(intentToggle);
        popup.appendChild(topRow);

        var currentIntentOpt = intents.find(function (i) { return i.value === selectedIntent; });
        if (currentIntentOpt) defaultPlaceholder = currentIntentOpt.placeholder;

      } else if (isFreehand) {
        // Freehand: stroke count info row
        var pathCount = fabricCanvas.getObjects().filter(function (o) {
          return o._redlineIndex === annotationIndex && o.type !== 'text';
        }).length;
        var strokeRow = document.createElement('div');
        Object.assign(strokeRow.style, { display: 'flex', alignItems: 'center', gap: '4px' });
        var strokeInfo = document.createElement('span');
        Object.assign(strokeInfo.style, {
          flex: '1', fontSize: '11px', padding: '2px 6px', borderRadius: '4px',
          color: '#7cb3ff', background: 'rgba(42,107,219,0.08)'
        });
        strokeInfo.textContent = pathCount + ' stroke' + (pathCount !== 1 ? 's' : '');
        strokeRow.appendChild(strokeInfo);
        popup.appendChild(strokeRow);

      } else {
        // Text/other: simple type header
        var header = document.createElement('div');
        Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '8px' });
        var typeSpan = document.createElement('span');
        typeSpan.textContent = ann.type || 'annotation';
        Object.assign(typeSpan.style, { color: '#7cb3ff', fontWeight: '600', fontSize: '13px', flex: '1' });
        header.appendChild(typeSpan);
        popup.appendChild(header);
      }

      var textarea = buildDialogTextarea({ placeholder: defaultPlaceholder, value: ann.comment || '' });
      popup.appendChild(textarea);

      function finish(val) { popup.remove(); resolve(val); }

      var footerOpts = {
        hint: 'Edit annotation',
        onSendBack: function () { finish({ action: 'sendBack' }); },
        sendBackTip: 'Send to back — reveal annotations behind',
        onDelete: function () { finish({ action: 'delete' }); },
        deleteTip: 'Delete annotation',
        cancelTip: 'Cancel',
        onCancel: function () { finish(null); },
        actionIcon: pencilSvg,
        actionTip: 'Save changes',
        onAction: function () {
          var result = { action: 'save', comment: textarea.value.trim() };
          if (isDrawType && selectedIntent) result.intent = selectedIntent;
          finish(result);
        },
        requireInput: textarea,
        validate: function () {
          if (!textarea.value.trim()) return { valid: false, reason: 'Enter a description first' };
          return { valid: true };
        }
      };
      var footer = buildDialogFooter(footerOpts);
      popup.appendChild(footer);

      document.body.appendChild(popup);
      var popupTop = Math.max(10, Math.min(y - 24, window.innerHeight - popup.offsetHeight - 10));
      popup.style.top = popupTop + 'px';

      setTimeout(function () { textarea.focus(); }, 0);
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var result = { action: 'save', comment: textarea.value.trim() };
          if (isDrawType && selectedIntent) result.intent = selectedIntent;
          finish(result);
        }
        if (e.key === 'Escape') finish(null);
        if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish({ action: 'delete' });
        }
      });
    });
  }

  // --- Highlight all objects belonging to an annotation ---
  function highlightAnnotation(annotationIndex) {
    var objects = fabricCanvas.getObjects().filter(function (o) { return o._redlineIndex === annotationIndex; });
    if (!objects.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objects.forEach(function (o) {
      var b = o.getBoundingRect();
      if (b.left < minX) minX = b.left;
      if (b.top < minY) minY = b.top;
      if (b.left + b.width > maxX) maxX = b.left + b.width;
      if (b.top + b.height > maxY) maxY = b.top + b.height;
    });
    var pad = 4;
    var box = new fabric.Rect({
      left: minX - pad, top: minY - pad,
      width: maxX - minX + pad * 2, height: maxY - minY + pad * 2,
      fill: 'rgba(42,107,219,0.08)', stroke: '#2a6bdb', strokeWidth: 2,
      strokeDashArray: [6, 4], selectable: false, evented: false
    });
    fabricCanvas.add(box);
    fabricCanvas.renderAll();
    return box;
  }

  function findOrphanAtPoint(x, y) {
    var objects = fabricCanvas.getObjects();
    for (var i = objects.length - 1; i >= 0; i--) {
      var obj = objects[i];
      if (obj._redlineIndex != null && obj._redlineIndex < annotations.length) continue;
      var b = obj.getBoundingRect();
      if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
        return obj;
      }
    }
    return null;
  }

  function showOrphanDeletePopup(x, y, orphan) {
    return new Promise(function (resolve) {
      var popupLeft = x + 16;
      if (popupLeft + 300 > window.innerWidth - 10) popupLeft = x - 16 - 300;

      var popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed', left: popupLeft + 'px', top: '-9999px',
        width: '290px', zIndex: '2147483647', background: '#1a1a2e', borderRadius: '12px',
        padding: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        border: '1px solid #2a2a3e', display: 'flex', flexDirection: 'column', gap: '8px'
      });

      var info = document.createElement('span');
      info.textContent = 'Orphaned object — not linked to any annotation';
      Object.assign(info.style, {
        color: '#e63946', fontSize: '11px', padding: '2px 6px', borderRadius: '4px',
        background: 'rgba(230,57,70,0.08)'
      });
      popup.appendChild(info);

      function finish(val) { popup.remove(); resolve(val); }

      var footer = buildDialogFooter({
        hint: '',
        cancelTip: 'Keep',
        onCancel: function () { finish(false); },
        actionTip: 'Delete orphaned object',
        actionIcon: trashSvg,
        actionColor: '#e63946',
        onAction: function () { finish(true); }
      });
      popup.appendChild(footer);

      document.body.appendChild(popup);
      var popupTop = Math.max(10, Math.min(y - 24, window.innerHeight - popup.offsetHeight - 10));
      popup.style.top = popupTop + 'px';
    });
  }

  // --- Handle edit tool click ---
  async function handleEditClick(e) {
    if (isSelectBusy) return;
    var x = e.clientX, y = e.clientY;
    var idx = findAnnotationAtPoint(x, y);

    // No annotation found — check for orphaned canvas objects
    if (idx == null) {
      var orphan = findOrphanAtPoint(x, y);
      if (!orphan) return;
      isSelectBusy = true;
      var shouldDelete = await showOrphanDeletePopup(x, y, orphan);
      if (shouldDelete) {
        fabricCanvas.remove(orphan);
        fabricCanvas.renderAll();
        persistSession();
        showToast('Removed orphaned object');
      }
      fabricCanvas.discardActiveObject();
      fabricCanvas.renderAll();
      isSelectBusy = false;
      return;
    }

    var ann = annotations[idx];

    // For select-type annotations, reuse the full selection badge with nav/HTML/CSS
    if (ann.type === 'select' && ann.selector) {
      clearPendingSelect();
      var el = null;
      try { el = document.querySelector(ann.selector); } catch (e) {}
      if (!el) el = getElementUnderPoint(x, y);
      if (el && el !== document.body && el !== document.documentElement) {
        var hl = highlightElement(el);
        fabricCanvas.renderAll();
        pendingSelect = {
          element: el, highlight: hl, badgeEl: null,
          editIndex: idx, editComment: ann.comment
        };
        showSelectionBadge(el);
        return;
      }
    }

    // For non-select annotations (arrow, circle, draw, text), use edit popup
    isSelectBusy = true;
    var selectionBox = highlightAnnotation(idx);
    var result = await showEditPopup(x, y, idx);
    if (selectionBox) { fabricCanvas.remove(selectionBox); }
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    isSelectBusy = false;

    if (!result) return;

    if (result.action === 'delete') {
      removeAnnotationCanvasObjects(idx);
      annotations.splice(idx, 1);
      annotationObjects.splice(idx, 1);
      updateCounter();
      persistSession();
      showToast('Removed annotation');
    } else if (result.action === 'sendBack') {
      var objs = fabricCanvas.getObjects().filter(function (o) { return o._redlineIndex === idx; });
      objs.forEach(function (o) { fabricCanvas.sendToBack(o); });
      fabricCanvas.renderAll();
      persistSession();
    } else if (result.action === 'save') {
      annotations[idx].comment = result.comment;
      if (result.intent) annotations[idx].intent = result.intent;
      updateAnnotationLabel(idx, result.comment);
      persistSession();
    }
  }

  function removeAnnotationCanvasObjects(index) {
    var toRemove = fabricCanvas.getObjects().filter(function (o) { return o._redlineIndex === index; });
    toRemove.forEach(function (o) { fabricCanvas.remove(o); });
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    // Re-index higher annotations
    fabricCanvas.getObjects().forEach(function (o) {
      if (o._redlineIndex != null && o._redlineIndex > index) {
        o._redlineIndex--;
      }
    });
  }

  function removePendingAnnotation() {
    if (!pendingSelect || pendingSelect.editIndex == null) return;
    var idx = pendingSelect.editIndex;
    removeAnnotationCanvasObjects(idx);
    annotations.splice(idx, 1);
    annotationObjects.splice(idx, 1);
    clearPendingSelect();
    updateCounter();
    persistSession();
    showToast('Removed annotation');
  }

  function sendBackPendingAnnotation() {
    if (!pendingSelect || pendingSelect.editIndex == null) return;
    var idx = pendingSelect.editIndex;
    var objs = fabricCanvas.getObjects().filter(function (o) { return o._redlineIndex === idx; });
    objs.forEach(function (o) { fabricCanvas.sendToBack(o); });
    fabricCanvas.renderAll();
    clearPendingSelect();
    persistSession();
  }

  function submitPendingSelect() {
    if (!pendingSelect) return;

    var textarea = pendingSelect.badgeEl ? pendingSelect.badgeEl.querySelector('textarea') : null;
    var comment = textarea ? textarea.value.trim() : '';
    if (!comment) return;

    var element = pendingSelect.element;
    var highlight = pendingSelect.highlight;
    var rect = element.getBoundingClientRect();
    var editIndex = pendingSelect.editIndex;

    // Remove badge but keep highlight
    if (pendingSelect.badgeEl) pendingSelect.badgeEl.remove();

    // If editing, remove old canvas objects
    if (editIndex != null) {
      removeAnnotationCanvasObjects(editIndex);
    }

    var selector = getCssSelector(element);
    var selectSnap = fabricCanvas.getObjects().length;
    addAnnotationLabel(comment, rect.right + 6, rect.top);
    fabricCanvas.renderAll();

    var snapshot = getComputedSnapshot(element);
    var annotationData = {
      type: 'select',
      selector: selector,
      comment: comment,
      tagName: element.tagName,
      classes: element.className || '',
      text: (element.textContent || '').trim().substring(0, 80),
      position: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      computedCss: snapshot.computedCss,
      html: snapshot.html,
      childHints: snapshot.childHints
    };

    if (editIndex != null) {
      annotations[editIndex] = annotationData;
      annotationObjects[editIndex] = { snapshotCount: selectSnap };
      highlight._redlineIndex = editIndex;
      tagCanvasObjects(editIndex, selectSnap);
    } else {
      var annIdx = annotations.length;
      annotations.push(annotationData);
      annotationObjects.push({ snapshotCount: selectSnap });
      highlight._redlineIndex = annIdx;
      tagCanvasObjects(annIdx, selectSnap);
    }
    updateCounter();
    persistSession();

    pendingSelect = null;
  }

  // --- Handle element selection (click to select, click again to traverse up DOM) ---
  function handleElementClick(e) {
    if (currentTool !== 'select' || isSelectBusy) return;

    var x = e.clientX;
    var y = e.clientY;
    var element = getElementUnderPoint(x, y);

    if (!element || element === document.body || element === document.documentElement) {
      clearPendingSelect();
      return;
    }

    var selector = getCssSelector(element);

    // Edit: if this element is already annotated, open badge in edit mode
    var existingIndex = -1;
    for (var i = 0; i < annotations.length; i++) {
      if (annotations[i].type === 'select' && annotations[i].selector === selector) {
        existingIndex = i;
        break;
      }
    }
    // Also check canvas objects at click point for non-select annotations (draw, arrow, etc.)
    if (existingIndex === -1) {
      var canvasIdx = findAnnotationAtPoint(x, y);
      if (canvasIdx != null) existingIndex = canvasIdx;
    }
    if (existingIndex !== -1) {
      clearPendingSelect();
      var existingAnnotation = annotations[existingIndex];
      var highlight = highlightElement(element);
      fabricCanvas.renderAll();
      pendingSelect = {
        element: element, highlight: highlight, badgeEl: null,
        editIndex: existingIndex, editComment: existingAnnotation.comment
      };
      showSelectionBadge(element);
      return;
    }

    // Click same element again → unselect
    if (pendingSelect && pendingSelect.element === element) {
      clearPendingSelect();
      return;
    }

    // New selection (or clicked a different element)
    clearPendingSelect();
    var highlight = highlightElement(element);
    fabricCanvas.renderAll();
    pendingSelect = { element: element, highlight: highlight, badgeEl: null };
    showSelectionBadge(element);
  }

  // --- Initialize canvas (shared between new and resumed sessions) ---
  function initCanvas() {
    overlayEl = document.createElement('canvas');
    overlayEl.id = '__redline_canvas';
    Object.assign(overlayEl.style, {
      position: 'fixed', inset: '0', zIndex: '2147483645',
      width: '100vw', height: '100vh', cursor: 'crosshair'
    });
    document.body.appendChild(overlayEl);

    fabricCanvas = new fabric.Canvas('__redline_canvas', {
      width: window.innerWidth,
      height: window.innerHeight,
      selection: false
    });

    var wrapperEl = fabricCanvas.wrapperEl;
    Object.assign(wrapperEl.style, {
      position: 'fixed', inset: '0', zIndex: '2147483645'
    });

    fabricCanvas.backgroundColor = 'rgba(0,0,0,0.05)';
    fabricCanvas.renderAll();

    // Expose for debugging
    window.__redline_fabric = fabricCanvas;

    // Prevent scroll events from reaching underlying elements (e.g. Monaco editor)
    var wrapperForScroll = fabricCanvas.wrapperEl;
    window.__redline_blockScroll = function (e) { e.preventDefault(); e.stopPropagation(); };
    wrapperForScroll.addEventListener('wheel', window.__redline_blockScroll, { passive: false });
    wrapperForScroll.addEventListener('touchmove', window.__redline_blockScroll, { passive: false });

    createToolbar();
    setupCanvasDrawing();

    window.__redline_resize = function () {
      fabricCanvas.setDimensions({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', window.__redline_resize);
  }

  // --- Activate ---
  async function activate() {
    var saved = getSavedSession();

    if (saved) {
      var choice = await showResumeDialog(saved);
      if (choice === null) return; // Escape — cancel
      if (choice === 'resume') {
        sessionName = saved.sessionName;
        annotations = saved.annotations || [];
        annotationObjects = [];
        requireFabric();
        initCanvas();
        // Restore canvas objects from saved JSON
        if (saved.canvasJson) {
          var parsedCanvas = typeof saved.canvasJson === 'string' ? JSON.parse(saved.canvasJson) : saved.canvasJson;
          fabricCanvas.loadFromJSON(parsedCanvas, function () {
            var objs = fabricCanvas.getObjects();
            var srcObjs = parsedCanvas.objects || [];
            for (var ri = 0; ri < objs.length; ri++) {
              // Restore _redlineIndex from serialized data
              if (ri < srcObjs.length) {
                if (srcObjs[ri]._redlineIndex != null) objs[ri]._redlineIndex = srcObjs[ri]._redlineIndex;
                if (srcObjs[ri]._isLabelBg) objs[ri]._isLabelBg = true;
              }
              // Prevent Fabric.js from making restored objects interactive
              objs[ri].set({ selectable: false, evented: false });
            }
            fabricCanvas.discardActiveObject();
            fabricCanvas.renderAll();
          });
        }
        // Restore tool state
        if (saved.currentTool) {
          currentTool = saved.currentTool;
          setTool(currentTool);
        }
        updateCounter();
        active = true;
        autosaveInterval = setInterval(persistSession, 1000);
        // Restore pending selection if there was one — use a short delay so DOM is settled
        if (saved.pendingState) {
          setTimeout(function () {
            var ps = saved.pendingState;
            var restoredEl = null;

            // Try querySelector first (wrap in try — complex selectors may throw)
            if (ps.selector) {
              try { restoredEl = document.querySelector(ps.selector); } catch (e) {
                // Complex selectors (Tailwind brackets/colons) may throw — fall through to elementFromPoint
              }
            }

            // Fall back to elementFromPoint — temporarily hide redline layers
            if (!restoredEl && ps.cx != null) {
              var wrapper = fabricCanvas ? fabricCanvas.wrapperEl : null;
              if (wrapper) wrapper.style.pointerEvents = 'none';
              if (toolbarEl) toolbarEl.style.pointerEvents = 'none';
              restoredEl = document.elementFromPoint(ps.cx, ps.cy);
              if (wrapper) wrapper.style.pointerEvents = '';
              if (toolbarEl) toolbarEl.style.pointerEvents = '';
            }

            if (restoredEl && restoredEl !== document.body && restoredEl !== document.documentElement) {
              var hl = highlightElement(restoredEl);
              fabricCanvas.renderAll();
              pendingSelect = {
                element: restoredEl, highlight: hl, badgeEl: null,
                editIndex: ps.editIndex,
                editComment: ps.comment || null
              };
              showSelectionBadge(restoredEl);
            }
          }, 500);
        }
        showToast('Resumed session "' + sessionName + '" with ' + annotations.length + ' annotation(s)');
        return;
      }
      // choice === 'new' — fall through to new session
    }

    var name = await showNameDialog();
    if (!name) return;
    sessionName = name;

    requireFabric();
    initCanvas();

    active = true;
    annotations = [];
    annotationObjects = [];
    autosaveInterval = setInterval(persistSession, 1000);
    showToast('Redline active — click elements to annotate, then press ' + (IS_MAC ? 'Cmd' : 'Ctrl') + '+Shift+A when done');
  }

  // --- Save annotations ---
  async function saveAnnotations() {
    var annotationsScreenshot = getAnnotationsScreenshot();
    var pageScreenshot = await getPageScreenshot();
    var data = {
      view: window.location.pathname,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      annotations: annotations,
      screenshots: {
        page: pageScreenshot,
        annotations: annotationsScreenshot
      }
    };

    var json = JSON.stringify(data, null, 2);
    var filename = sessionName + '.json';

    // Both Tauri and browser: download to ~/Downloads and copy filename
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    navigator.clipboard.writeText(filename).catch(function () {});
    showToast(filename + ' copied to clipboard — run /redline ' + filename, 6000);
  }

  // --- Export canvas annotations as screenshot data URL ---
  // Fabric.js toDataURL with multiplier:1 (default) exports at CSS pixel dimensions,
  // matching the page screenshot dimensions (window.innerWidth x window.innerHeight)
  function getAnnotationsScreenshot() {
    if (!fabricCanvas) return null;
    try {
      return fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
    } catch (e) {
      return null;
    }
  }

  // --- Capture page screenshot (without overlay) ---
  // Priority: 1) Tauri native WKWebView snapshot (pixel-perfect)
  //           2) Chrome extension captureVisibleTab (pixel-perfect)
  //           3) foreignObject SVG clone (fallback, limited fidelity)
  function getPageScreenshot() {
    return new Promise(function (resolve) {
      // Hide all redline UI
      var wrapperEl = fabricCanvas ? fabricCanvas.wrapperEl : null;
      var prevWrapper = wrapperEl ? wrapperEl.style.display : null;
      var prevToolbar = toolbarEl ? toolbarEl.style.display : null;
      if (wrapperEl) wrapperEl.style.display = 'none';
      if (toolbarEl) toolbarEl.style.display = 'none';

      function restore() {
        if (wrapperEl) wrapperEl.style.display = prevWrapper;
        if (toolbarEl) toolbarEl.style.display = prevToolbar;
      }

      // Wait one frame so the hidden UI is actually repainted before capture
      requestAnimationFrame(function () {
        // 1) Try Tauri native screenshot command
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
          window.__TAURI__.core.invoke('plugin:redline|capture_screenshot')
            .then(function (dataUrl) {
              restore();
              // WKWebView snapshot may include the title bar area, making it
              // taller than the viewport. Crop to viewport dimensions so
              // annotations (drawn relative to viewport) align correctly.
              cropToViewport(dataUrl, resolve);
            })
            .catch(function () {
              tryChromeCapture(restore, resolve);
            });
          return;
        }

        // 2) Try Chrome extension / foreignObject fallback
        tryChromeCapture(restore, resolve);
      });
    });
  }

  function cropToViewport(dataUrl, resolve) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var img = new Image();
    img.onload = function () {
      if (img.naturalWidth !== vw || img.naturalHeight !== vh) {
        // Snapshot dimensions differ from viewport — crop to top-left vw×vh
        var canvas = document.createElement('canvas');
        canvas.width = vw;
        canvas.height = vh;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, vw, vh, 0, 0, vw, vh);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } else {
        resolve(dataUrl);
      }
    };
    img.onerror = function () { resolve(dataUrl); };
    img.src = dataUrl;
  }

  function tryChromeCapture(restore, resolve) {
    window.__redline_capture_data = undefined;
    var marker = document.createElement('div');
    marker.id = '__redline_capture_req';
    marker.style.display = 'none';
    document.body.appendChild(marker);

    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (window.__redline_capture_data !== undefined) {
        clearInterval(poll);
        var data = window.__redline_capture_data;
        window.__redline_capture_data = undefined;
        restore();
        resolve(data);
      } else if (attempts > 40) {
        clearInterval(poll);
        captureForeignObject(restore, resolve);
      }
    }, 50);
  }

  // Cache fetched external stylesheet contents so we only fetch once per URL
  var externalCSSCache = {};

  function fetchExternalStylesheets() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    var promises = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href;
      if (!href || externalCSSCache[href] !== undefined) continue;
      (function (url) {
        promises.push(
          fetch(url).then(function (r) { return r.text(); }).then(function (css) {
            externalCSSCache[url] = css;
          }).catch(function () {
            externalCSSCache[url] = null;
          })
        );
      })(href);
    }
    return promises.length > 0 ? Promise.all(promises) : Promise.resolve();
  }

  function captureForeignObject(restore, resolve) {
    var w = window.innerWidth;
    var h = window.innerHeight;

    // Fetch external stylesheets first, then capture
    fetchExternalStylesheets().then(function () {
      try {
        var clone = document.documentElement.cloneNode(true);

        // Replace <link rel="stylesheet"> with inline <style> for external CSS.
        // foreignObject in a data URI can't fetch cross-origin stylesheets.
        var cloneLinks = clone.querySelectorAll('link[rel="stylesheet"]');
        for (var li = 0; li < cloneLinks.length; li++) {
          var linkEl = cloneLinks[li];
          var css = externalCSSCache[linkEl.href || linkEl.getAttribute('href')];
          if (css) {
            var inlineStyle = clone.ownerDocument
              ? clone.ownerDocument.createElement('style')
              : document.createElement('style');
            inlineStyle.textContent = css;
            linkEl.parentNode.replaceChild(inlineStyle, linkEl);
          }
        }

        // Remove Fabric canvas wrapper and toolbar from clone
        var canvasWrapper = clone.querySelector('.canvas-container');
        if (canvasWrapper) canvasWrapper.remove();
        var canvasEl = clone.querySelector('#__redline_canvas');
        if (canvasEl) canvasEl.remove();
        clone.querySelectorAll('[style*="2147483647"]').forEach(function (el) { el.remove(); });

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' +
          new XMLSerializer().serializeToString(clone) +
          '</foreignObject></svg>';

        var img = new Image();
        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          restore();
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.onerror = function () { restore(); resolve(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      } catch (e) {
        restore(); resolve(null);
      }
    });
  }

  // Build a tree-index path from document root to an element (for clone mapping)
  function getTreePath(el) {
    var path = [];
    var current = el;
    while (current && current !== document.documentElement) {
      var parent = current.parentElement;
      if (!parent) break;
      var idx = Array.prototype.indexOf.call(parent.children, current);
      path.unshift(idx);
      current = parent;
    }
    return path;
  }

  // Resolve a tree-index path on a cloned element tree
  function resolveTreePath(root, path) {
    var current = root;
    for (var i = 0; i < path.length; i++) {
      if (!current.children || !current.children[path[i]]) return null;
      current = current.children[path[i]];
    }
    return current;
  }

  // --- Reset All ---
  function resetAll() {
    if (!active) return;
    clearPendingSelect();
    clearPendingDraw();
    if (autosaveInterval) { clearInterval(autosaveInterval); autosaveInterval = null; }

    // Clear all canvas objects
    if (fabricCanvas) {
      fabricCanvas.clear();
      fabricCanvas.backgroundColor = 'rgba(0,0,0,0.05)';
      fabricCanvas.renderAll();
    }

    // Reset state
    annotations = [];
    annotationObjects = [];
    updateCounter();

    // Clear saved session from storage
    clearSavedSession();

    // Restart autosave
    autosaveInterval = setInterval(persistSession, 1000);
    showToast('All annotations cleared');
  }

  // --- Deactivate ---
  async function deactivate() {
    clearPendingSelect();
    clearPendingDraw();
    if (autosaveInterval) { clearInterval(autosaveInterval); autosaveInterval = null; }
    // Always persist final state — session is NEVER auto-cleared
    persistSession();
    if (annotations.length > 0) {
      await saveAnnotations();
    } else {
      showToast('No annotations yet — session saved, resume anytime');
    }

    // Cleanup
    if (fabricCanvas) {
      var wrapperToRemove = fabricCanvas.wrapperEl;
      fabricCanvas.dispose();
      if (wrapperToRemove && wrapperToRemove.parentNode) wrapperToRemove.remove();
      fabricCanvas = null;
    }
    if (overlayEl && overlayEl.parentNode) { overlayEl.remove(); }
    overlayEl = null;

    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    if (window.__redline_resize) {
      window.removeEventListener('resize', window.__redline_resize);
      delete window.__redline_resize;
    }
    if (window.__redline_blockScroll) {
      delete window.__redline_blockScroll;
    }
    active = false;
    currentTool = 'select';
  }

  // --- Hotkey listener ---
  // Cmd+Option+Shift+A (Mac) / Ctrl+Alt+Shift+A (Win/Linux)
  // Uses e.code because Option+Shift+A produces 'Å' on Mac, not 'A'
  document.addEventListener('keydown', function (e) {
    var mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.altKey && e.shiftKey && e.code === 'KeyA') {
      e.preventDefault();
      if (active) {
        deactivate();
      } else {
        activate();
      }
    }
    // Escape to cancel pending selection or pending draw
    if (active && e.key === 'Escape' && pendingSelect && !isSelectBusy) {
      clearPendingSelect();
    }
    if (active && e.key === 'Escape' && pendingDraw) {
      clearPendingDraw();
    }
  });

  // Force persist on page unload so nothing is lost
  window.addEventListener('beforeunload', function () {
    if (active) persistSession();
  });

  // Debug: expose toggle and test functions globally
  window.__redline_activate = function () { if (!active) activate(); };
  window.__redline_deactivate = function () { if (active) deactivate(); };
  window.__redline_test = function () {
    if (!fabricCanvas) return 'Canvas not active';
    var vpt = fabricCanvas.viewportTransform;
    var retina = fabricCanvas.getRetinaScaling ? fabricCanvas.getRetinaScaling() : 'N/A';
    var upperRect = fabricCanvas.upperCanvasEl.getBoundingClientRect();
    return JSON.stringify({
      viewportTransform: vpt,
      enableRetinaScaling: fabricCanvas.enableRetinaScaling,
      retinaScaling: retina,
      canvasW: fabricCanvas.width,
      canvasH: fabricCanvas.height,
      upperCanvasRect: { left: upperRect.left, top: upperRect.top, width: upperRect.width, height: upperRect.height },
      dpr: window.devicePixelRatio
    }, null, 2);
  };

  console.log('[Redline] Annotation overlay loaded. Press ' + (IS_MAC ? 'Cmd' : 'Ctrl') + '+Shift+A to start annotating.');
})();
