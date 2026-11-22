/* Box service worker: lets the page be installed as an app (home screen, share menu). It caches nothing:
 * every request goes to the network as usual, so the app always shows the live Box. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
