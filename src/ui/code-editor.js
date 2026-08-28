// Syntax highlighting for a textarea, which cannot carry markup of its own:
// the colours are painted into a second element behind it, and the textarea
// on top keeps its own text transparent. The two stay in register only for as
// long as they agree about content and scroll.
//
// See docs/DESIGN-NOTES.md § The editor is a textarea with a painted shadow

export function createHighlighter({ textarea, output, highlight }) {
  let live = false;
  let bound = false;

  const clear = () => { output.innerHTML = ''; };

  const paint = () => {
    const src = textarea.value ?? '';
    if (!src) { clear(); return; }
    try {
      // The last line of a value ending in a newline has no height of its own,
      // so the overlay would come up one line short of the caret.
      output.innerHTML = highlight(src.endsWith('\n') ? src + ' ' : src);
    } catch {
      live = false;
      clear();
    }
  };

  const onInput = () => { if (live) paint(); };
  const onScroll = () => {
    output.scrollTop = textarea.scrollTop;
    output.scrollLeft = textarea.scrollLeft;
  };

  return {
    get live() { return live; },
    paint,

    attach() {
      if (bound) return;
      bound = true;
      live = true;
      textarea.addEventListener('input', onInput);
      textarea.addEventListener('scroll', onScroll);
    },

    detach() {
      live = false;
      clear();
    },
  };
}
