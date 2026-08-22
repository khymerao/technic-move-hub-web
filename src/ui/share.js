// The share row on the landing page.
//
// Plain links, no third-party script. The page's claim is that it talks to the
// hub and to nothing else, and a vendor's share widget would make that false on
// first paint rather than on a click.
//
// Copy link is the one that carries this project: most of its audience lives in
// forum threads and Discord servers, where sharing is a pasted URL and not a
// button on anyone's page. It stays hidden until the clipboard is known to
// exist, so a browser without one shows three links instead of a dead fourth.

export function initShare() {
  const btn = document.getElementById('share-copy');
  if (!btn || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;

  btn.hidden = false;
  const label = btn.textContent;
  let restore = 0;

  btn.addEventListener('click', async () => {
    // The canonical URL, not location.href: a visitor arriving on a preview
    // deployment or with tracking parameters would otherwise pass those on.
    const url = document.querySelector('link[rel="canonical"]')?.href || location.href;
    let said = 'copied';
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Denied permission and an insecure context both land here.
      said = 'could not copy';
    }
    btn.textContent = said;
    btn.dataset.said = '';
    clearTimeout(restore);
    restore = setTimeout(() => {
      btn.textContent = label;
      delete btn.dataset.said;
    }, 2000);
  });
}
