// spark-html-motion — declarative enter/leave transitions for Spark, the Spark
// way: no compiler, no virtual DOM. It plugs into the core's lifecycle seam
// (`lifecycle()` from spark-html) and animates nodes that if/each blocks add or
// remove. Animation is the Web Animations API (0 deps); a leaving node is held
// in the DOM until its exit animation finishes, then removed.
//
//   import { mount } from 'spark-html';
//   import { motion } from 'spark-html-motion';
//   motion();           // register once, before mount()
//   mount(document.body);
//
//   <template each="t in todos">
//     <li transition="slide">{t.text}</li>     <!-- or transition:fade -->
//   </template>
//
// Opt in per element with `transition="fade|slide|scale"` (or the directive
// form `transition:fade`). Tune with `transition-duration="300"` (ms) and
// `transition-easing="ease-out"`. Honors prefers-reduced-motion.

import { lifecycle } from 'spark-html';

export const presets = {
  fade: {
    in: [{ opacity: 0 }, { opacity: 1 }],
    out: [{ opacity: 1 }, { opacity: 0 }],
  },
  slide: {
    in: [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    out: [
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(8px)' },
    ],
  },
  scale: {
    in: [
      { opacity: 0, transform: 'scale(.96)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    out: [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(.96)' },
    ],
  },
};

const prefersReduced = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

// Resolve an element's transition config from its attributes, or null to skip.
function configFor(node, defaults) {
  if (!node || node.nodeType !== 1 || !node.getAttribute) return null;
  let name = node.getAttribute('transition');
  if (name == null && node.attributes) {
    for (const a of node.attributes) {
      if (a.name && a.name.indexOf('transition:') === 0) {
        name = a.name.slice('transition:'.length);
        break;
      }
    }
  }
  if (name == null) return null; // not opted in
  name = (name && name.trim()) || defaults.preset;
  const keyframes = presets[name] || presets[defaults.preset];
  const dAttr = node.getAttribute('transition-duration');
  const d = dAttr != null && dAttr !== '' ? Number(dAttr) : NaN;
  const duration = Number.isFinite(d) && d >= 0 ? d : defaults.duration;
  const easing = node.getAttribute('transition-easing') || defaults.easing;
  return { keyframes, duration, easing };
}

export function motion(options = {}) {
  const defaults = {
    preset: options.preset || 'fade',
    duration: options.duration != null ? options.duration : 200,
    easing: options.easing || 'ease',
  };

  // Don't animate the initial mount unless asked — only later enters. The first
  // render runs synchronously inside mount(); flip `ready` on a later frame.
  let ready = !!options.appear;
  if (!ready && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ready = true;
      }),
    );
  }

  const canAnimate = (node) =>
    typeof node.animate === 'function' && !prefersReduced();

  lifecycle({
    enter(node) {
      if (!ready) return;
      const cfg = configFor(node, defaults);
      if (!cfg || !canAnimate(node)) return;
      node.animate(cfg.keyframes.in, {
        duration: cfg.duration,
        easing: cfg.easing,
      });
    },
    leave(node, remove) {
      const cfg = configFor(node, defaults);
      if (!cfg || !canAnimate(node)) {
        remove();
        return;
      }
      const anim = node.animate(cfg.keyframes.out, {
        duration: cfg.duration,
        easing: cfg.easing,
        fill: 'forwards', // hold the faded-out frame until we detach
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        remove();
      };
      if (anim && anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(finish, finish);
      } else if (anim && typeof anim.addEventListener === 'function') {
        anim.addEventListener('finish', finish);
        anim.addEventListener('cancel', finish);
      } else {
        finish();
      }
    },
  });
}

export default motion;
