/**
 * js/firebase-config.js
 * Konfigurasi Resmi Firebase Realtime Database - SKAWAN TV
 * SMK Negeri 1 Pacitan (SKASA)
 * 
 * Versi Kompatibel Browser (Tanpa 'import', langsung siap di semua browser)
 */

(function initSkawanDatabase() {
  const firebaseConfig = {
    apiKey: "AIzaSyAtSTgrBWY5aDahE6hq_yr4oSxpxl3QtcQ",
    authDomain: "skawan-tv.firebaseapp.com",
    databaseURL: "https://skawan-tv-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "skawan-tv",
    storageBucket: "skawan-tv.firebasestorage.app",
    messagingSenderId: "501619282826",
    appId: "1:501619282826:web:81e624ac35e9798062ae73"
  };

  if (typeof firebase !== 'undefined') {
    if (!firebase.apps || !firebase.apps.length) {
      try {
        firebase.initializeApp(firebaseConfig);
        console.log("[SKAWAN TV] Firebase initialized successfully.");
      } catch (err) {
        console.warn("[SKAWAN TV] Firebase init warning:", err);
      }
    }
    
    if (firebase.database) {
      window.db = firebase.database();
      console.log("[SKAWAN TV] Realtime Database instance ready on window.db");
    }
  } else {
    console.error("[SKAWAN TV] Pustaka Firebase SDK compat belum termuat di head HTML!");
  }
})();

// Deklarasikan variabel global 'db' agar dapat langsung dipanggil oleh semua halaman
var db = window.db || (typeof firebase !== 'undefined' && firebase.database ? firebase.database() : null);
