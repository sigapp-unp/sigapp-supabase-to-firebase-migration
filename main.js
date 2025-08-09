#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Migración Supabase -> Cloud Firestore (Node.js)
 *
 * - Lee tablas:
 *    gt_course_tracking, gt_grade_categories, gt_grades, user_preferences
 * - Escribe en Firestore:
 *    /students/{studentCode}/gradeSimulations/{courseCode}
 *        { categories: Map, grades: Map, lastModified: serverTimestamp }
 *    /students/{studentCode}/preferences/global
 *    /students/{studentCode}/preferences/_semesters/data/{semesterId}
 *
 * Configuración: ver .env o variables de entorno.
 */

require("dotenv").config();

const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const admin = require("firebase-admin");
const pLimit = require("p-limit");

// ---------------------- Config ----------------------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  FIREBASE_SERVICE_ACCOUNT_PATH,
  MIGRATE_SINCE,
  PAGE_SIZE = "500",
  CONCURRENCY = "10",
  STRUCTURE_MODE = "embedded", // 'embedded' | 'subcollections'
  DRY_RUN = "false",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}

if (!FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error("❌ Falta FIREBASE_SERVICE_ACCOUNT_PATH en .env");
  process.exit(1);
}

const pageSize = Math.max(1, parseInt(PAGE_SIZE, 10));
const concurrency = Math.max(1, parseInt(CONCURRENCY, 10));
const dryRun = /^true$/i.test(DRY_RUN);

// ---------------------- SDKs ------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (...args) => fetch(...args) },
});

// Firebase Admin init
const serviceAccount = require(path.resolve(FIREBASE_SERVICE_ACCOUNT_PATH));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const bulk = db.bulkWriter();
bulk.onWriteError((err) => {
  // retry con backoff
  if (err.failedAttempts < 5) {
    const delay = Math.pow(2, err.failedAttempts) * 100; // 100,200,400,800,1600ms
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  console.error("❌ Write error sin reintento:", err);
  return false;
});

// ---------------------- Utilidades ------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iso(d) {
  if (!d) return null;
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function numberOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function bool(x) {
  return !!x;
}

// ---------------------- Lecturas Supabase -----------
async function pageCourseTrackings({ since, from = 0, to = pageSize - 1 }) {
  let q = supabase
    .from("gt_course_tracking")
    .select("id, student_code, course_code, updated_at", { count: "exact" })
    .order("updated_at", { ascending: true })
    .range(from, to);

  if (since) {
    q = q.gte("updated_at", since);
  }

  const { data, error, count } = await q;
  if (error) throw error;
  return { data: data || [], count: count || 0 };
}

async function getCategoriesByTrackIds(trackIds) {
  const out = new Map(); // trackId -> array of categories
  if (trackIds.length === 0) return out;

  // PostgREST limita IN a ~1000; chunk por seguridad
  for (const ids of chunk(trackIds, 500)) {
    const { data, error } = await supabase
      .from("gt_grade_categories")
      .select("id, course_tracking_id, name, weight, updated_at")
      .in("course_tracking_id", ids);
    if (error) throw error;
    for (const c of data || []) {
      const arr = out.get(c.course_tracking_id) || [];
      arr.push(c);
      out.set(c.course_tracking_id, arr);
    }
  }
  return out;
}

async function getGradesByCategoryIds(catIds) {
  const out = new Map(); // categoryId -> array of grades
  if (catIds.length === 0) return out;

  for (const ids of chunk(catIds, 500)) {
    const { data, error } = await supabase
      .from("gt_grades")
      .select("id, category_id, name, score, enabled, updated_at")
      .in("category_id", ids);
    if (error) throw error;
    for (const g of data || []) {
      const arr = out.get(g.category_id) || [];
      arr.push(g);
      out.set(g.category_id, arr);
    }
  }
  return out;
}

async function pageUserPreferences({ from = 0, to = pageSize - 1 }) {
  let q = supabase
    .from("user_preferences")
    .select("student_code, preferences, updated_at", { count: "exact" })
    .order("updated_at", { ascending: true })
    .range(from, to);

  if (MIGRATE_SINCE) q = q.gte("updated_at", MIGRATE_SINCE);

  const { data, error, count } = await q;
  if (error) throw error;
  return { data: data || [], count: count || 0 };
}

// ---------------------- Escrituras Firestore --------
function buildSimulationEmbedded(categories, gradesByCat) {
  // Devuelve { categories: Map, grades: Map }
  const categoriesMap = {};
  const gradesMap = {};

  for (const c of categories) {
    const catId = String(c.id);
    categoriesMap[catId] = {
      id: catId,
      name: c.name,
      weight: numberOrNull(c.weight),
    };
    const grades = gradesByCat.get(c.id) || [];
    for (const g of grades) {
      const gradeId = String(g.id);
      gradesMap[gradeId] = {
        id: gradeId,
        categoryId: catId,
        name: g.name,
        score: numberOrNull(g.score),
        enabled: bool(g.enabled),
      };
    }
  }

  return { categories: categoriesMap, grades: gradesMap };
}

async function writeSimulationEmbedded({ studentCode, courseCode, payload }) {
  const ref = db
    .collection("students")
    .doc(studentCode)
    .collection("gradeSimulations")
    .doc(courseCode);

  const body = {
    ...payload,
    lastModified: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (dryRun) {
    console.log("[DRY-RUN] set", ref.path);
    return;
  }
  await bulk.set(ref, body, { merge: true });
}

async function writeSimulationSubcollections({
  studentCode,
  courseCode,
  categories,
  gradesByCat,
}) {
  const base = db
    .collection("students")
    .doc(studentCode)
    .collection("gradeSimulations")
    .doc(courseCode);

  if (dryRun) {
    console.log("[DRY-RUN] set", base.path);
    return;
  }

  // marca lastModified en el doc principal
  await bulk.set(
    base,
    { lastModified: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  // escribe categorías
  for (const c of categories) {
    const ref = base.collection("categories").doc(String(c.id));
    await bulk.set(
      ref,
      { id: String(c.id), name: c.name, weight: numberOrNull(c.weight) },
      { merge: true }
    );
  }

  // escribe notas
  for (const c of categories) {
    const grades = gradesByCat.get(c.id) || [];
    for (const g of grades) {
      const ref = base.collection("grades").doc(String(g.id));
      await bulk.set(
        ref,
        {
          id: String(g.id),
          categoryId: String(c.id),
          name: g.name,
          score: numberOrNull(g.score),
          enabled: bool(g.enabled),
        },
        { merge: true }
      );
    }
  }
}

async function writePreferences({ studentCode, preferences }) {
  const studentRef = db.collection("students").doc(studentCode);

  // separa en global vs _semesters.data
  const global = (preferences && preferences.global) || {};
  const semestersData =
    (preferences && preferences._semesters && preferences._semesters.data) ||
    {};

  // /preferences/global
  const globalRef = studentRef.collection("preferences").doc("global");
  if (!dryRun) {
    await bulk.set(
      globalRef,
      {
        ...global,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    console.log("[DRY-RUN] set", globalRef.path);
  }

  // /preferences/_semesters/data/{semesterId}
  const dataCol = studentRef
    .collection("preferences")
    .doc("_semesters")
    .collection("data");
  for (const [semesterId, payload] of Object.entries(semestersData)) {
    const ref = dataCol.doc(String(semesterId));
    if (!dryRun) {
      await bulk.set(
        ref,
        {
          ...(payload || {}),
          migratedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      console.log("[DRY-RUN] set", ref.path);
    }
  }
}

// ---------------------- Proceso principal -----------
async function migrateSimulations() {
  console.log("==> Migrando gradeSimulations...");
  let from = 0;
  let to = pageSize - 1;
  let total = 0;
  let processed = 0;

  // primer ping para obtener count
  const first = await pageCourseTrackings({ since: MIGRATE_SINCE, from, to });
  total = first.count;
  console.log(
    `Registros en gt_course_tracking (filtro desde=${iso(
      MIGRATE_SINCE
    )}): ${total}`
  );

  // loop por páginas
  let pageIndex = 0;
  while (true) {
    const { data } =
      pageIndex === 0
        ? first
        : await pageCourseTrackings({ since: MIGRATE_SINCE, from, to });
    if (!data || data.length === 0) break;

    const trackIds = data.map((t) => t.id);
    const byTrack = await getCategoriesByTrackIds(trackIds);

    // todas las categories del batch
    const allCats = Array.from(byTrack.values()).flat();
    const gradesByCat = await getGradesByCategoryIds(allCats.map((c) => c.id));

    const limit = pLimit(concurrency);
    const jobs = [];

    for (const t of data) {
      const studentCode = String(t.student_code);
      const courseCode = String(t.course_code);
      const categories = byTrack.get(t.id) || [];

      if (STRUCTURE_MODE === "embedded") {
        const payload = buildSimulationEmbedded(categories, gradesByCat);
        jobs.push(
          limit(() =>
            writeSimulationEmbedded({ studentCode, courseCode, payload })
          )
        );
      } else {
        jobs.push(
          limit(() =>
            writeSimulationSubcollections({
              studentCode,
              courseCode,
              categories,
              gradesByCat,
            })
          )
        );
      }
    }

    await Promise.all(jobs);
    processed += data.length;
    console.log(
      `  • Página ${pageIndex + 1}: ${
        data.length
      } elementos → acumulado ${processed}/${total}`
    );
    pageIndex += 1;
    from += pageSize;
    to += pageSize;
    // pequeña pausa para cortes elegantes
    await sleep(50);
  }

  console.log(`==> gradeSimulations listo. Procesados: ${processed}`);
}

async function migratePreferencesAll() {
  console.log("==> Migrando user_preferences...");
  let from = 0;
  let to = pageSize - 1;
  let total = 0;
  let processed = 0;

  const first = await pageUserPreferences({ from, to });
  total = first.count;
  console.log(
    `Registros en user_preferences (filtro desde=${iso(
      MIGRATE_SINCE
    )}): ${total}`
  );

  let pageIndex = 0;
  while (true) {
    const { data } =
      pageIndex === 0 ? first : await pageUserPreferences({ from, to });
    if (!data || data.length === 0) break;

    const limit = pLimit(concurrency);
    const jobs = [];

    for (const r of data) {
      const studentCode = String(r.student_code);
      jobs.push(
        limit(() =>
          writePreferences({ studentCode, preferences: r.preferences || {} })
        )
      );
    }

    await Promise.all(jobs);
    processed += data.length;
    console.log(
      `  • Página ${pageIndex + 1}: ${
        data.length
      } elementos → acumulado ${processed}/${total}`
    );
    pageIndex += 1;
    from += pageSize;
    to += pageSize;
    await sleep(50);
  }

  console.log(`==> user_preferences listo. Procesados: ${processed}`);
}

(async function main() {
  const started = Date.now();
  console.log("🚀 Iniciando migración Supabase → Firestore");
  console.log(`   Modo estructura: ${STRUCTURE_MODE} | DRY_RUN=${dryRun}`);
  try {
    await migrateSimulations();
    await migratePreferencesAll();

    if (!dryRun) {
      console.log("⏳ Esperando flush de BulkWriter...");
      await bulk.close(); // asegura que todo se haya enviado
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✅ Migración terminada en ${secs}s`);
  } catch (err) {
    console.error("❌ Error durante la migración:", err);
    try {
      await bulk.close();
    } catch {}
    process.exit(1);
  }
})();
