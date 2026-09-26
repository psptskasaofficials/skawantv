/**
 * js/firebase-config.js
 * Konfigurasi Resmi Firebase Realtime Database - SKAWAN TV
 * SMK Negeri 1 Pacitan (SKASA)
 */

// Objek konfigurasi Firebase project: skawan-tv
const firebaseConfig = {
  apiKey: "AIzaSyAtSTgrBWY5aDahE6hq_yr4oSxpxl3QtcQ",
  authDomain: "skawan-tv.firebaseapp.com",
  databaseURL: "https://skawan-tv-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "skawan-tv",
  storageBucket: "skawan-tv.firebasestorage.app",
  messagingSenderId: "501619282826",
  appId: "1:501619282826:web:81e624ac35e9798062ae73"
};

// Inisialisasi Firebase App
if (typeof firebase !== 'undefined') {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log("[SKAWAN TV] Firebase App berhasil diinisialisasi.");
  }
  
  // Daftarkan variabel database 'db' ke objek global window
  // agar dapat diakses secara simultan oleh semua file HTML
  window.db = firebase.database();
  var db = window.db;
  console.log("[SKAWAN TV] Realtime Database siap digunakan.");
} else {
  console.error("[SKAWAN TV] Pustaka Firebase SDK belum termuat di dokumen HTML!");
}
