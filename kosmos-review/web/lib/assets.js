// Images and videos in the document carry data-asset="assets/<file>" and no src: the browser would
// send no token for a plain src, and every read needs one. So each asset is fetched with the token
// (through the API client) as a Blob and shown from a blob: URL.
//
// A blob: URL is a same-origin address. An SVG opened from one in its own tab would run its scripts with
// access to this page's sessionStorage (and so the token). Images therefore revoke their URL as soon as
// they have loaded, which also makes "open image in new tab" fail instead of exposing that. Videos keep
// theirs, because streaming needs it, and a video file is not a document that can run script.

const defaultBlobUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

export function loadAssets(root, assetBlob, blobUrls = defaultBlobUrls) {
  let cancelled = false;
  root.querySelectorAll('[data-asset]').forEach((el) => {
    if (el.dataset.assetState) return;
    el.dataset.assetState = 'loading';
    assetBlob(el.dataset.asset).then(
      (blob) => {
        if (cancelled) return;
        const url = blobUrls.create(blob);
        if (el.localName === 'img') {
          const revoke = () => blobUrls.revoke(url);
          el.onload = revoke;
          el.onerror = revoke;
        }
        el.src = url;
        el.dataset.assetState = 'done';
      },
      (err) => {
        if (cancelled) return;
        el.dataset.assetState = 'error';
        el.classList.add('asset-error');
        el.title = `Could not load ${el.dataset.asset}: ${err.message}`;
      },
    );
  });
  return () => { cancelled = true; };
}
