/**
 * auth.js — ExamLens Firebase Authentication Module
 *
 * Loaded AFTER the Firebase compat CDN scripts in index.html.
 * Exposes all auth functions as window globals so the main
 * application script can call them directly.
 *
 * Firebase compat SDK is used (no bundler required).
 */

/* ─────────────────────────────────────────────────────────────────────
   FIREBASE CONFIG — your project's client-side configuration
───────────────────────────────────────────────────────────────────── */
const firebaseConfig = {
  apiKey:            "AIzaSyBeW81pZ-4zXBACzlllTQL_kjPosDOIiSU",
  authDomain:        "examlens-4a9bb.firebaseapp.com",
  projectId:         "examlens-4a9bb",
  storageBucket:     "examlens-4a9bb.firebasestorage.app",
  messagingSenderId: "32354043046",
  appId:             "1:32354043046:web:17287b32fcec2f8f02a067",
  measurementId:     "G-DX6BBNQTZ9",
};

/* ─────────────────────────────────────────────────────────────────────
   INITIALISE
───────────────────────────────────────────────────────────────────── */
firebase.initializeApp(firebaseConfig);

const AUTH           = firebase.auth();
const GOOGLE_PROVIDER = new firebase.auth.GoogleAuthProvider();

// Always prompt account selection for Google login (good UX)
GOOGLE_PROVIDER.setCustomParameters({ prompt: 'select_account' });

/* ─────────────────────────────────────────────────────────────────────
   AUTH STATE OBSERVER
   Calls window.onAuthStateChange(user) whenever sign-in state changes.
   The main application script defines this function.
───────────────────────────────────────────────────────────────────── */
AUTH.onAuthStateChanged(user => {
  if (typeof window.onAuthStateChange === 'function') {
    window.onAuthStateChange(user);
  }
});

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC API — all exposed as window globals
═══════════════════════════════════════════════════════════════════ */

/**
 * Get a fresh Firebase ID token for the current user.
 * Must be called before every authenticated API request.
 * Pass forceRefresh=true if you need a guaranteed fresh token.
 */
window.getIdToken = async function (forceRefresh = false) {
  const user = AUTH.currentUser;
  if (!user) throw new Error('Not authenticated. Please sign in.');
  return user.getIdToken(forceRefresh);
};

/**
 * Sign in with email and password.
 * Throws a Firebase AuthError on failure (code + message).
 */
window.signInWithEmail = async function (email, password) {
  return AUTH.signInWithEmailAndPassword(email.trim(), password);
};

/**
 * Register a new account with email, password, and optional display name.
 * Automatically updates the Firebase profile with the display name.
 */
window.registerWithEmail = async function (email, password, displayName) {
  const credential = await AUTH.createUserWithEmailAndPassword(email.trim(), password);
  if (displayName && displayName.trim()) {
    await credential.user.updateProfile({ displayName: displayName.trim() });
    // Reload so onAuthStateChanged sees the updated name
    await credential.user.reload();
    // Manually fire the state change since reload doesn't always trigger it
    if (typeof window.onAuthStateChange === 'function') {
      window.onAuthStateChange(AUTH.currentUser);
    }
  }
  return credential;
};

/**
 * Sign in with Google via popup.
 */
window.signInWithGoogle = async function () {
  return AUTH.signInWithPopup(GOOGLE_PROVIDER);
};

/**
 * Sign out the current user.
 */
window.signOutUser = async function () {
  return AUTH.signOut();
};

/**
 * Get the currently signed-in Firebase User object (or null).
 */
window.getCurrentUser = function () {
  return AUTH.currentUser;
};

/**
 * Translate Firebase AuthError codes into human-friendly messages.
 */
window.friendlyAuthError = function (error) {
  const map = {
    'auth/invalid-email':            'Please enter a valid email address.',
    'auth/user-disabled':            'This account has been disabled.',
    'auth/user-not-found':           'No account found with this email.',
    'auth/wrong-password':           'Incorrect password. Please try again.',
    'auth/email-already-in-use':     'An account with this email already exists.',
    'auth/weak-password':            'Password must be at least 6 characters.',
    'auth/popup-closed-by-user':     'Google sign-in was cancelled.',
    'auth/network-request-failed':   'Network error. Check your connection.',
    'auth/too-many-requests':        'Too many attempts. Please wait a moment.',
    'auth/invalid-credential':       'Incorrect email or password.',
  };
  return map[error.code] || error.message || 'An unexpected error occurred.';
};
