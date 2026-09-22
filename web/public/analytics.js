/* Firebase Analytics, loaded from the CDN as a module.
 *
 * Both halves of the site include this: the landing page with a <script
 * type="module"> tag, the manual through Starlight's `head` in
 * astro.config.mjs. One file, so the measurement id cannot drift between them.
 *
 * The config below is a Firebase *web* config. It is not a secret — it ships in
 * every page of every Firebase web app, and access is controlled by the
 * project's security rules, not by hiding these strings.
 *
 * Everything here is best-effort. `getAnalytics` throws in a browser with no
 * IndexedDB (private windows on some platforms, and anything with storage
 * blocked), and a failed import of a third-party module must never be the
 * reason a documentation page does not render — hence the catch on both.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getAnalytics,
  isSupported,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-analytics.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBuI73xaGoMwk1biOx5bI2JBFt5Fb7HlVc',
  authDomain: 'talea-run.firebaseapp.com',
  projectId: 'talea-run',
  storageBucket: 'talea-run.firebasestorage.app',
  messagingSenderId: '274098272546',
  appId: '1:274098272546:web:ee3ad440332ce710710d7b',
  measurementId: 'G-09B7DL76RZ',
};

try {
  // `isSupported()` is the check that keeps this quiet where analytics cannot
  // run at all, rather than throwing into the console on every page view.
  if (await isSupported()) getAnalytics(initializeApp(firebaseConfig));
} catch {
  /* analytics is not worth a broken page */
}
