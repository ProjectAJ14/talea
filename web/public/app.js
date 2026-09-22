/* talea landing page behaviour: the hero terminal + scroll reveals.
   No dependencies, no build step — this file is served as-is. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the hero terminal ----------
     A talea run the visitor drives. It boots itself — types
     `talea init ~/Workspace` — and stops there, armed, with the keyboard
     handed over. From that point every state is the visitor's: send the
     command, tick what this machine should keep with the arrows and the
     space bar the real picker takes, accept, and watch the live block fill.

     States: boot · armed · picking · running · done. */
  (function () {
    var term = document.querySelector('[data-term]');
    if (!term) return;

    var screen = term.querySelector('[data-screen]');
    var logEl = screen.querySelector('[data-log]');
    var dock = screen.querySelector('[data-dock]');
    var $ = function (sel) { return screen.querySelector(sel); };

    var lines = {};
    [].slice.call(screen.querySelectorAll('[data-line]')).forEach(function (el) {
      lines[el.getAttribute('data-line')] = el;
    });

    var boot = $('[data-boot]'), bootCur = $('[data-boot-cur]');
    var composer = $('[data-composer]'), echo = $('[data-echo]'), echoCur = $('[data-echo-cur]');
    var input = $('[data-input]'), hint = $('[data-hint]');
    var nudge = $('[data-nudge]'), pickNudge = $('[data-nudge-pick]');
    var optWrap = $('[data-opts]'), keysEl = $('[data-keys]'), countEl = $('[data-count]');
    var opts = [].slice.call(screen.querySelectorAll('.ask__opt'));
    var groupRows = [].slice.call(screen.querySelectorAll('.ask__grp'));
    var board = $('[data-board]'), countsEl = $('[data-counts]'), afterEl = $('[data-after]');
    var statusEl = term.querySelector('[data-status]');

    var CMD = 'talea init ~/Workspace';

    /* What each repo does when the run reaches it. These are the four outcomes
       the CLI actually prints — cloned, adopted, skipped, and a skip with a
       reason — not four made-up ones. `label` is what the summary counts. */
    var RUN = {
      eklavya: { group: 'ProjectAJ14', kind: 'ok', label: 'adopted', busy: 'matching remotes …', note: 'moved from ~/dev/clone2/eklavya' },
      talea: { group: 'ProjectAJ14', kind: 'ok', label: 'cloned', busy: 'cloning …', note: 'main' },
      Morph: { group: 'ProjectAJ14', kind: 'ok', label: 'cloned', busy: 'cloning …', note: 'main' },
      flutter_forge: { group: 'nonstopio', kind: 'ok', label: 'cloned', busy: 'cloning …', note: 'main' },
      'json-viewer': { group: 'nonstopio', kind: 'skip', label: 'skipped', busy: 'reading catalogue …', note: 'ignore: true — another tool owns it' },
      ns_puzzle: { group: 'nonstopio', kind: 'ok', label: 'cloned', busy: 'cloning …', note: 'main' }
    };

    /* The glyphs are content, not decoration: they are what src/theme.js
       prints, and they are what a log with colour stripped still says. */
    var GLYPH = { ok: '▣', skip: '◌', fail: '▤' };
    var SPIN = ['◜', '◠', '◝', '◞', '◡', '◟'];
    /* The picker's own marks, from `renderRow` and `GROUP_MARK` in
       src/prompt.js: a repo is filled or hollow, a group is filled, half or
       hollow depending on how many of its repos are ticked. */
    var BOX = { on: '◼', off: '◻' };
    var GROUP_BOX = { all: '◼', some: '◐', none: '◻' };

    var state = 'boot';
    /* Each nudge fires once per visit. Someone who has already driven the
       picker does not need to be told how a second time. */
    var nudged = { composer: false, pick: false };
    var timers = [], idle = null, spin = null;

    function at(ms, fn) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }
    function stop() { timers.forEach(clearTimeout); timers = []; }

    /* The screen is the scroller, so every new line pins itself to the
       bottom the way a real terminal does. */
    function toBottom() { logEl.scrollTop = logEl.scrollHeight; }
    function show(el) {
      el.hidden = false;
      if (reduced) { el.classList.add('is-on'); toBottom(); return; }
      requestAnimationFrame(function () { el.classList.add('is-on'); toBottom(); });
    }
    function hide(el) { el.hidden = true; el.classList.remove('is-on'); }

    function type(el, text, speed, done) {
      if (reduced) { el.textContent = text; done(); return; }
      var i = 0;
      (function step() {
        el.textContent = text.slice(0, ++i);
        toBottom();
        if (i < text.length) at(speed, step);
        else at(240, done);
      }());
    }

    var picked = function () {
      return opts.filter(function (o) { return o.classList.contains('is-picked'); });
    };

    /* ---------- boot ---------- */
    function bootUp() {
      bootCur.hidden = false;
      at(650, function () {
        type(boot, CMD, 55, function () {
          bootCur.hidden = true;
          at(300, function () {
            show(dock);
            at(300, function () { type(echo, CMD, 26, arm); });
          });
        });
      });
    }

    /* Clicking mid-boot skips to the armed prompt — nobody should have to
       wait out an animation to use the thing. */
    function skipBoot() {
      stop();
      boot.textContent = CMD;
      bootCur.hidden = true;
      show(dock);
      echo.textContent = CMD;
      arm();
    }

    function arm(again) {
      state = 'armed';
      dock.classList.remove('is-busy');
      input.disabled = false;
      composer.classList.add('is-armed');
      echoCur.hidden = false;
      input.value = echo.textContent;
      hint.hidden = false;
      hint.innerHTML = again
        ? 'change the list, or press <kbd>⏎</kbd> to run it again'
        : 'press <kbd>⏎</kbd> to run';
      toBottom();
      nudgeAfter('composer', nudge, 4200);
    }

    /* Nothing moves until the visitor acts, so say so — but only after long
       enough that it reads as help rather than impatience. */
    function nudgeAfter(key, el, ms) {
      if (nudged[key] || reduced) return;
      clearTimeout(idle);
      idle = setTimeout(function () { nudged[key] = true; show(el); }, ms);
    }
    function calm() {
      // called on every mousemove over the picker, so bail before touching the DOM
      if (!idle && nudge.hidden && pickNudge.hidden) return;
      clearTimeout(idle); idle = null; hide(nudge); hide(pickNudge);
    }

    /* ---------- the run ---------- */
    function send() {
      if (state !== 'armed') return;
      calm();
      reset();
      state = 'picking';
      /* A shell does not take the prompt away while a command runs — it sits
         there dimmed and waits, so that is what this does. */
      dock.classList.add('is-busy');
      composer.classList.remove('is-armed');
      hint.hidden = true;
      input.disabled = true;

      show(lines.head);
      at(220, function () { show(lines.ctx); });
      at(620, function () {
        show(lines.pick);
        optWrap.classList.add('is-live');
        keysEl.hidden = false;
        at(200, function () { setCur(0); });
        nudgeAfter('pick', pickNudge, 4500);
      });
    }

    /* ---------- the picker ---------- */
    var cur = 0;
    function setCur(i) {
      cur = (i + opts.length) % opts.length;
      opts.forEach(function (o, n) { o.classList.toggle('is-cur', n === cur); });
      opts[cur].focus({ preventScroll: true });
      toBottom();
    }
    function setPicked(el, on) {
      el.classList.toggle('is-picked', on);
      el.querySelector('.ask__box').textContent = on ? BOX.on : BOX.off;
    }
    function toggle(el) {
      if (state !== 'picking') return;
      setPicked(el, !el.classList.contains('is-picked'));
      tally();
    }
    function setAll(on) {
      if (state !== 'picking') return;
      opts.forEach(function (o) { setPicked(o, on); });
      tally();
    }
    function tally() {
      var n = picked().length;
      countEl.textContent = n + ' of ' + opts.length + ' selected';

      // Each group row reports its own three-state mark, as GROUP_MARK does.
      groupRows.forEach(function (row) {
        var mine = opts.filter(function (o) { return RUN[o.dataset.repo].group === row.dataset.group; });
        var on = mine.filter(function (o) { return o.classList.contains('is-picked'); }).length;
        row.querySelector('.ask__box').textContent =
          GROUP_BOX[on === 0 ? 'none' : on === mine.length ? 'all' : 'some'];
      });

      var groups = {};
      picked().forEach(function (o) { groups[RUN[o.dataset.repo].group] = 1; });
      var g = Object.keys(groups).length;
      statusEl.textContent =
        '[TALEA ' + n + ' of ' + opts.length + ' kept · ' + g + ' group' + (g === 1 ? '' : 's') + ']';
    }

    /* q and Esc, as the real picker binds them: nothing is written and the
       shell gets its prompt back. */
    function cancel() {
      if (state !== 'picking') return;
      calm();
      optWrap.classList.remove('is-live');
      keysEl.hidden = true;
      opts.forEach(function (o) { o.classList.remove('is-cur'); o.blur(); });
      afterEl.textContent = 'cancelled — .talea.json not written, nothing changed';
      show(lines.after);
      at(500, function () { state = 'done'; arm(true); toBottom(); });
    }

    /* ---------- the live block ---------- */
    function accept() {
      if (state !== 'picking') return;
      state = 'running';
      calm();
      optWrap.classList.remove('is-live');
      keysEl.hidden = true;
      opts.forEach(function (o) { o.classList.remove('is-cur'); o.blur(); });

      var chosen = picked().map(function (o) { return o.dataset.repo; });
      if (!chosen.length) {
        // An empty selection is a real answer — "I chose nothing" — and talea
        // says so rather than drawing an empty box.
        board.innerHTML = '<div class="row"><span class="row__g">·</span>' +
          '<span class="row__note">nothing selected — nothing to do</span></div>';
        show(lines.work);
        at(500, function () { finish([]); });
        return;
      }

      board.innerHTML = '';
      var rows = {};
      var lastGroup = null;
      chosen.forEach(function (id) {
        var r = RUN[id];
        if (r.group !== lastGroup) {
          lastGroup = r.group;
          var n = chosen.filter(function (x) { return RUN[x].group === r.group; }).length;
          var head = document.createElement('div');
          head.className = 'grp';
          head.innerHTML = '◇ ' + r.group + ' <span class="grp__rule">' +
            new Array(Math.max(2, 34 - r.group.length)).join('─') +
            '</span><span class="grp__n"> ' + n + ' repo' + (n === 1 ? '' : 's') + '</span>';
          board.appendChild(head);
        }
        var row = document.createElement('div');
        row.className = 'row row--busy';
        row.innerHTML = '<span class="row__g">·</span><span class="row__name">' + id +
          '</span><span class="row__note"></span>';
        board.appendChild(row);
        rows[id] = row;
      });
      show(lines.work);

      // One spinner for the whole block, as live.js drives it.
      var f = 0;
      if (!reduced) {
        spin = setInterval(function () {
          f++;
          [].forEach.call(board.querySelectorAll('.row--busy .row__g'), function (g) {
            g.textContent = SPIN[f % SPIN.length];
          });
        }, 110);
      }

      chosen.forEach(function (id, i) {
        var r = RUN[id];
        at(200 + i * 120, function () {
          rows[id].querySelector('.row__note').textContent = r.busy;
          toBottom();
        });
        at(900 + i * 480, function () {
          rows[id].className = 'row row--' + r.kind;
          rows[id].querySelector('.row__g').textContent = GLYPH[r.kind];
          rows[id].querySelector('.row__note').textContent = r.note;
          toBottom();
        });
      });

      at(900 + chosen.length * 480 + 400, function () { finish(chosen); });
    }

    function finish(chosen) {
      clearInterval(spin); spin = null;

      // The summary counts by outcome label, and prints only the parts that
      // are not zero — the same rule `summary()` follows.
      var by = {};
      chosen.forEach(function (id) {
        var l = RUN[id].label;
        by[l] = (by[l] || 0) + 1;
      });
      var parts = ['cloned', 'adopted', 'skipped'].filter(function (l) { return by[l]; })
        .map(function (l) { return '<b>' + by[l] + '</b> ' + l; });

      countsEl.innerHTML = parts.length ? parts.join(' · ') : 'nothing to do';
      show(lines.done);

      at(600, function () {
        afterEl.textContent = chosen.length
          ? 'cd $(talea where ' + chosen[0] + ')  →  ~/Workspace/' + RUN[chosen[0]].group + '/' + chosen[0]
          : 'nothing changed — run it again with something ticked';
        show(lines.after);
      });
      at(1300, function () {
        state = 'done';
        arm(true);
        /* They just drove the picker; "press ⏎ to run it again" should be true
           without hunting for the prompt first. */
        input.focus({ preventScroll: true });
        toBottom();
      });
    }

    /* Everything the last run printed, put back. The ticks are deliberately
       left alone: a second run is how you see a different selection play out. */
    function reset() {
      stop(); clearInterval(spin); spin = null;
      ['head', 'ctx', 'pick', 'work', 'done', 'after'].forEach(function (k) { hide(lines[k]); });
      board.innerHTML = '';
      countsEl.textContent = '';
      afterEl.textContent = '';
      optWrap.classList.remove('is-live');
      keysEl.hidden = false;
      calm();
    }

    /* ---------- input ---------- */
    input.addEventListener('input', function () { echo.textContent = input.value; toBottom(); });
    input.addEventListener('focus', calm);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    nudge.addEventListener('click', function () { calm(); send(); });
    pickNudge.addEventListener('click', function () { calm(); setCur(cur); });

    /* Clicking the screen puts you on the prompt, as it would in a shell. */
    screen.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      if (state === 'boot') { e.preventDefault(); skipBoot(); return; }
      if (state !== 'armed') return;
      e.preventDefault();
      input.focus({ preventScroll: true });
    });

    optWrap.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.ask__opt') : null;
      if (el) { calm(); toggle(el); setCur(opts.indexOf(el)); }
    });
    optWrap.addEventListener('mousemove', function (e) {
      if (state !== 'picking') return;
      calm();
      var el = e.target.closest ? e.target.closest('.ask__opt') : null;
      var i = opts.indexOf(el);
      if (i > -1 && i !== cur) setCur(i);
    });
    /* Arrows walk the list, space toggles, enter accepts — the three keys the
       real raw-mode picker in src/prompt.js binds. */
    optWrap.addEventListener('keydown', function (e) {
      if (state !== 'picking') return;
      calm();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCur(cur + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle(opts[cur]);
      } else if (e.key === 'a' || e.key === 'n') {
        e.preventDefault();
        setAll(e.key === 'a');
      } else if (e.key === 'q' || e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        accept();
      }
    });

    tally();
    screen.setAttribute('data-ready', '');
    /* Don't run the boot into an empty room: a visitor who lands on #commands
       should still find the terminal at its armed prompt when they scroll up. */
    if (reduced || !('IntersectionObserver' in window)) { skipBoot(); return; }
    var seen = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      seen.disconnect();
      bootUp();
    }, { threshold: 0.25 });
    seen.observe(term);
  }());

  /* ---------- scroll reveals ---------- */
  var reveals = [].slice.call(document.querySelectorAll('[data-reveal]'));
  var shoots = [].slice.call(document.querySelectorAll('[data-shoot]'));

  function show(el) {
    if (el.dataset.delay) el.style.transitionDelay = el.dataset.delay + 'ms';
    el.classList.add('is-visible');
  }
  /* Restart the whole group from frame zero. A CSS animation only replays when
     its animation-name changes, so drop it inline, force a reflow, then hand it
     back to the stylesheet. Descendants carry their own animations, hence the
     `*` — same set the paused rule in styles.css covers. */
  function fire(el) {
    var parts = [].slice.call(el.querySelectorAll('[data-anim], [data-anim] *'));
    el.classList.remove('is-firing');
    parts.forEach(function (p) { p.style.animation = 'none'; });
    void el.offsetWidth;
    parts.forEach(function (p) { p.style.animation = ''; });
    el.classList.add('is-firing');
  }

  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach(show);
    shoots.forEach(fire);
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      // [data-shoot] keeps its observer: the loop pauses when the section
      // leaves and replays from the beginning the next time it is on screen.
      if (el.hasAttribute('data-shoot')) {
        if (entry.isIntersecting) fire(el);
        else el.classList.remove('is-firing');
        return;
      }
      if (!entry.isIntersecting) return;
      show(el);
      io.unobserve(el);
    });
  }, { threshold: 0.15 });

  reveals.concat(shoots).forEach(function (el) { io.observe(el); });
}());

/* ---------------------------------------------------------------
   The ground toggle. window.taleaGround is defined by the blocking
   script in <head>, which has already applied the stored choice to
   <html> — but the buttons did not exist yet, so their pressed
   state is re-synced here before they are bound.
   --------------------------------------------------------------- */
window.taleaGround.apply(window.taleaGround.read());
document.querySelectorAll('[data-ground]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    window.taleaGround.set(btn.dataset.ground);
  });
});

/* ---------------------------------------------------------------
   Live star count. Unauthenticated api.github.com is rate-limited
   per IP, so this fails silently and the button keeps its label —
   a visitor who hits the limit sees "Star", never "0".
   --------------------------------------------------------------- */
(function () {
  var el = document.querySelector('[data-stars]');
  if (!el) return;
  fetch('https://api.github.com/repos/ProjectAJ14/talea')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var n = d && d.stargazers_count;
      if (typeof n !== 'number') return;
      el.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k'
                                 : String(n);
      el.hidden = false;
    })
    .catch(function () {});
})();

/* ---------------------------------------------------------------
   A copy button on every block that holds a shell command.

   The command lines are the ones with a `$` prompt; anything else
   in the block is sample output and must not end up on the
   clipboard. The prompt itself is dropped too — pasting `$ npm …`
   into a shell is a syntax error.
   --------------------------------------------------------------- */
(function () {
  var blocks = document.querySelectorAll('.cta__code, .dash__cmd');
  if (!blocks.length || !navigator.clipboard) return;

  blocks.forEach(function (block) {
    var lines = [].filter.call(block.children, function (row) {
      return row.querySelector('span') && !row.classList.contains('dash__cmd-out');
    }).map(function (row) {
      var clone = row.cloneNode(true);
      var prompt = clone.querySelector('span');
      if (prompt) prompt.remove();
      return clone.textContent.trim();
    }).filter(Boolean);
    if (!lines.length) return;

    block.classList.add('cmd-block');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cmd-copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy command to clipboard');
    block.appendChild(btn);

    var reset;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(lines.join('\n')).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('is-done');
        clearTimeout(reset);
        reset = setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('is-done');
        }, 1600);
      });
    });
  });
})();
