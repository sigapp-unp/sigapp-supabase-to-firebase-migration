#!/usr/bin/env node
import "dotenv/config";
import path from "path";
import fs from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const serviceAccountRaw = fs.readFileSync(
  path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH!),
  "utf8"
);
const serviceAccount = JSON.parse(serviceAccountRaw);

const app = initializeApp({
  credential: cert(serviceAccount as any),
});

const db = getFirestore(app);

async function testFirestore() {
  try {
    console.log("🔥 Probando conexión a Firestore...");

    // Prueba de lectura
    const testDoc = db.collection("test").doc("connectivity");
    console.log("📖 Intentando leer documento de prueba...");
    const snapshot = await testDoc.get();
    console.log(`✅ Lectura exitosa. Existe: ${snapshot.exists}`);

    // Prueba de escritura
    console.log("✍️ Intentando escribir documento de prueba...");
    await testDoc.set({
      message: "Test de conectividad",
      timestamp: FieldValue.serverTimestamp(),
      test: true,
    });
    console.log("✅ Escritura exitosa!");

    // Verificar la escritura
    console.log("🔍 Verificando escritura...");
    const newSnapshot = await testDoc.get();
    console.log(`✅ Verificación exitosa. Data:`, newSnapshot.data());

    console.log("🎉 Firestore funciona correctamente!");
  } catch (error: any) {
    console.error("❌ Error en Firestore:", error.message);
    console.error("Stack:", error.stack);
  }
}

testFirestore();
