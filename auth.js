/**
 * auth.js — ExamLens Firebase Authentication Module  v3.0
 *
 * Loaded after Firebase compat CDN scripts.
 * Exposes all auth functions as window globals.
 */

const firebaseConfig = {
  apiKey:            "AIzaSyBeW81pZ-4zXBACzlllTQL_kjPosDOIiSU",
  authDomain:        "examlens-4a9bb.firebaseapp.com",
  projectId:         "examlens-4a9bb",
  storageBucket:     "examlens-4a9bb.firebasestorage.app",
  messagingSenderId: "32354043046",
  appId:             "1:32354043046:web:17287b32fcec2f8f02a067",
  measurementId:     "G-DX6BBNQTZ9",
};

firebase.initializeApp(firebaseConfig);

const AUTH            = firebase.auth();
const GOOGLE_PROVIDER = new firebase.auth.GoogleAuthProvider();
GOOGLE_PROVIDER.setCustomParameters({ prompt: 'select_account' });

AUTH.onAuthStateChanged(user => {
  if (typeof window.onAuthStateChange === 'function') window.onAuthStateChange(user);
});

window.getIdToken = async (forceRefresh = false) => {
  const user = AUTH.currentUser;
  if (!user) throw new Error('Not authenticated.');
  return user.getIdToken(forceRefresh);
};

window.signInWithEmail = (email, password) =>
  AUTH.signInWithEmailAndPassword(email.trim(), password);

window.registerWithEmail = async (email, password, displayName) => {
  const cred = await AUTH.createUserWithEmailAndPassword(email.trim(), password);
  if (displayName?.trim()) {
    await cred.user.updateProfile({ displayName: displayName.trim() });
    await cred.user.reload();
    if (typeof window.onAuthStateChange === 'function') window.onAuthStateChange(AUTH.currentUser);
  }
  return cred;
};

window.signInWithGoogle = () => AUTH.signInWithPopup(GOOGLE_PROVIDER);

window.signOutUser = () => AUTH.signOut();

window.getCurrentUser = () => AUTH.currentUser;

window.friendlyAuthError = (error) => {
  const map = {
    'auth/invalid-email':          'Please enter a valid email address.',
    'auth/user-disabled':          'This account has been disabled.',
    'auth/user-not-found':         'No account found with this email.',
    'auth/wrong-password':         'Incorrect password. Please try again.',
    'auth/email-already-in-use':   'An account with this email already exists.',
    'auth/weak-password':          'Password must be at least 6 characters.',
    'auth/popup-closed-by-user':   'Google sign-in was cancelled.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/too-many-requests':      'Too many attempts. Please wait a moment.',
    'auth/invalid-credential':     'Incorrect email or password.',
  };
  return map[error.code] || error.message || 'An unexpected error occurred.';
};
