#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Migración Supabase -> Cloud Firestore (TypeScript / Node.js)
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

import "dotenv/config";
import path from "path";
import fs from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
// Cambiar a API modular de firebase-admin v12+
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ---------------------- Tipos -----------------------

type Nullable<T> = T | null;

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  FIREBASE_SERVICE_ACCOUNT_PATH?: string;
  MIGRATE_SINCE?: string;
  PAGE_SIZE?: string;
  CONCURRENCY?: string;
  STRUCTURE_MODE?: "embedded" | "subcollections" | string;
  DRY_RUN?: string;
  CHECKPOINT_PATH?: string;
  FAILED_PATH?: string;
}

interface GTCourseTrackingRow {
  id: number | string;
  student_code: string | number;
  course_code: string | number;
  updated_at: string;
}

interface GTGradeCategoryRow {
  id: number | string;
  course_tracking_id: number | string;
  name: string;
  weight: number | string | null;
  created_at: string;
  updated_at: string;
}

interface GTGradeRow {
  id: number | string;
  category_id: number | string;
  name: string;
  score: number | string | null;
  enabled: boolean | number | null;
  updated_at: string;
}

type PreferencesJSON = Record<string, unknown> & {
  global?: Record<string, unknown>;
  _semesters?: {
    data?: Record<string, unknown>;
  };
};

type CategoriesByTrack = Map<GTCourseTrackingRow["id"], GTGradeCategoryRow[]>;
type GradesByCategory = Map<GTGradeCategoryRow["id"], GTGradeRow[]>;

type StructureMode = "embedded" | "subcollections";

// ---------------------- Concurrencia ----------------

// Función de concurrencia simple para reemplazar p-limit
function pLimit(concurrency: number) {
  type QueueTask = {
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  };
  const queue: QueueTask[] = [];
  let running = 0;

  const next = () => {
    if (running >= concurrency || queue.length === 0) return;

    running++;
    const { fn, resolve, reject } = queue.shift()!;
    fn()
      .then((v) => resolve(v))
      .catch((e) => reject(e))
      .finally(() => {
        running--;
        next();
      });
  };

  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        fn: fn as () => Promise<any>,
        resolve: (value: any) => resolve(value as T),
        reject: (reason?: any) => reject(reason),
      });
      next();
    });
}

// ---------------------- Config ----------------------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  FIREBASE_SERVICE_ACCOUNT_PATH,
  MIGRATE_SINCE,
  PAGE_SIZE = "500",
  CONCURRENCY = "10",
  STRUCTURE_MODE = "embedded",
  DRY_RUN = "false",
  CHECKPOINT_PATH,
  FAILED_PATH,
} = (process.env as Env) ?? {};

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}

if (!FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error("❌ Falta FIREBASE_SERVICE_ACCOUNT_PATH en .env");
  process.exit(1);
}

const pageSize = Math.max(1, parseInt(PAGE_SIZE!, 10));
const concurrency = Math.max(1, parseInt(CONCURRENCY!, 10));
const dryRun = /^true$/i.test(DRY_RUN!);
const structureMode: StructureMode =
  STRUCTURE_MODE === "subcollections" ? "subcollections" : "embedded";

// Define debugLimit for debugging purposes (paridad con el original)
// Permite desactivar el límite estableciendo DEBUG_LIMIT (p. ej. 500) o sin límite
const DEBUG_LIMIT: number = process.env.DEBUG_LIMIT
  ? Math.max(1, parseInt(process.env.DEBUG_LIMIT, 10))
  : (Infinity as number);

// Rutas locales
const CKPT_PATH = CHECKPOINT_PATH || "./checkpoint.json";
const FAILED_LOG_PATH = FAILED_PATH || "./failed.jsonl";

// ---------------------- SDKs ------------------------
const supabase: SupabaseClient = createClient(
  SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
    // realtime deshabilitado: no se especifica configuración no soportada
  }
);

// Firebase Admin init (API modular)
const serviceAccountRaw = fs.readFileSync(
  path.resolve(FIREBASE_SERVICE_ACCOUNT_PATH!),
  "utf8"
);
const serviceAccount = JSON.parse(serviceAccountRaw);

const app = initializeApp({
  credential: cert(serviceAccount as any),
});

const db = getFirestore(app);
const bulk = db.bulkWriter();
let totalWrites = 0;
bulk.onWriteError((err) => {
  // retry hasta 5 intentos; Firestore maneja el backoff internamente
  if ((err as any).failedAttempts < 5) {
    return true;
  }
  console.error("❌ Write error sin reintento:", err);
  return false;
});
// Comentar el onWriteResult problemático por ahora
// bulk.onWriteResult((_ref: any) => {
//   totalWrites += 1;
//   if (totalWrites % 50 === 0) {
//     console.log(`✳️ ${totalWrites} escrituras confirmadas`);
//   }
// });

// ---------------------- Utilidades ------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function saveCheckpoint(
  stage: string,
  { pageIndex, from, to }: { pageIndex: number; from: number; to: number }
) {
  let ckpt: Record<
    string,
    { pageIndex: number; from: number; to: number; ts: string }
  > = {};
  try {
    ckpt = JSON.parse(fs.readFileSync(CKPT_PATH, "utf8"));
  } catch {
    // vacío
  }
  ckpt[stage] = { pageIndex, from, to, ts: new Date().toISOString() };
  fs.writeFileSync(CKPT_PATH, JSON.stringify(ckpt, null, 2));
}

function loadCheckpoint(
  stage: string,
  pageSizeNum: number
): { pageIndex: number; from: number; to: number } {
  try {
    const ckpt = JSON.parse(fs.readFileSync(CKPT_PATH, "utf8"));
    return ckpt[stage] || { pageIndex: 0, from: 0, to: pageSizeNum - 1 };
  } catch {
    return { pageIndex: 0, from: 0, to: pageSizeNum - 1 };
  }
}

function recordFailed(rec: Record<string, unknown>) {
  fs.appendFileSync(
    FAILED_LOG_PATH,
    JSON.stringify({ ...rec, ts: new Date().toISOString() }) + "\n"
  );
}

async function withReadRetries<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (attempt === 0) {
        console.log(`🔄 Consultando Supabase...`);
      } else {
        console.log(`🔄 Reintento ${attempt + 1}/${tries}...`);
      }
      const result = await fn();
      if (attempt > 0) {
        console.log(`✅ Consulta exitosa después de ${attempt + 1} intentos`);
      }
      return result;
    } catch (e: any) {
      attempt++;
      console.error(`❌ Error en intento ${attempt}:`, e?.message ?? e);
      if (attempt >= tries) {
        console.error(`💥 Agotados ${tries} intentos, propagando error`);
        throw e;
      }
      const delay = 500 * Math.pow(2, attempt); // 500, 1000, 2000, 4000ms
      console.log(`⏳ Esperando ${delay}ms antes del siguiente intento...`);
      await sleep(delay);
    }
  }
}

function iso(d?: string | number | Date | null): Nullable<string> {
  if (!d) return null;
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}

function chunk<T>(array: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function numberOrNull(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function bool(x: unknown): boolean {
  return !!x;
}

function safePrefs(x: unknown): Record<string, any> {
  if (!x) return {};
  if (typeof x === "string") {
    try {
      return JSON.parse(x);
    } catch {
      return {};
    }
  }
  if (typeof x === "object") return x as Record<string, any>;
  return {};
}

function normalizeGlobal(globalRaw: Record<string, any> = {}) {
  const g: Record<string, any> = { ...globalRaw };
  if (g.course_chain) {
    const cc = g.course_chain || {};
    g.courseChain = {
      highlightCriticalPath:
        cc.highlight_critical_path ?? cc.highlightCriticalPath ?? false,
      viewMode: cc.view_mode ?? cc.viewMode ?? "tree",
      ...cc,
    };
    delete g.course_chain;
  }
  if (g.highlight_critical_path) {
    g.highlightCriticalPath = g.highlight_critical_path;
    delete g.highlight_critical_path;
  }
  if (g.view_mode) {
    g.viewMode = g.view_mode;
    delete g.view_mode;
  }
  return g;
}

// ---------------------- Lecturas Supabase -----------

async function pageCourseTrackings({
  since,
  from = 0,
  to = pageSize - 1,
}: {
  since?: string;
  from?: number;
  to?: number;
}): Promise<{ data: GTCourseTrackingRow[]; count: number }> {
  console.log(
    `📊 Debugging: Fetching gt_course_tracking desde=${
      since ? iso(since) : "inicio"
    }, range=${from}-${Math.min(to, DEBUG_LIMIT)}`
  );

  let q = supabase
    .from("gt_course_tracking")
    .select("id, student_code, course_code, updated_at", { count: "exact" })
    .order("updated_at", { ascending: true })
    .range(from, Math.min(to, DEBUG_LIMIT));

  if (since) {
    q = q.gte("updated_at", since);
  }

  try {
    const { data, error, count } = (await q) as unknown as {
      data: GTCourseTrackingRow[] | null;
      error: any;
      count: number | null;
    };
    if (error) {
      console.error("❌ Debugging: Error in pageCourseTrackings:", error);
      throw error;
    }
    console.log(
      `📊 Debugging: gt_course_tracking fetched ${
        (data || []).length
      } records (total: ${count || 0})`
    );
    return { data: data || [], count: count || 0 };
  } catch (e: any) {
    console.error("❌ Debugging: Error in pageCourseTrackings:", e.message);
    throw e;
  }
}

async function getCategoriesByTrackIds(
  trackIds: Array<GTCourseTrackingRow["id"]>
): Promise<CategoriesByTrack> {
  const out: CategoriesByTrack = new Map();
  if (trackIds.length === 0) return out;

  console.log(
    `📋 Obteniendo categorías para ${trackIds.length} tracking IDs...`
  );

  for (const [chunkIndex, ids] of chunk(trackIds, 100).entries()) {
    try {
      if (chunkIndex > 0) await sleep(100);

      const { data, error } = (await supabase
        .from("gt_grade_categories")
        .select("id, course_tracking_id, name, weight, created_at, updated_at")
        .in("course_tracking_id", ids)) as unknown as {
        data: GTGradeCategoryRow[] | null;
        error: any;
      };

      if (error) {
        console.error(`❌ Error en chunk ${chunkIndex + 1}:`, error);
        throw error;
      }

      if ((chunkIndex + 1) % 5 === 0 || chunkIndex === 0) {
        console.log(`  ✅ Chunks 1-${chunkIndex + 1}: categorías acumuladas`);
      }

      for (const c of data || []) {
        const arr = out.get(c.course_tracking_id) || [];
        arr.push(c);
        out.set(c.course_tracking_id, arr);
      }
    } catch (e: any) {
      console.error(
        `❌ Error en getCategoriesByTrackIds chunk ${chunkIndex + 1}:`,
        e.message
      );
      throw e;
    }
  }
  console.log(
    `📋 Total categorías obtenidas: ${Array.from(out.values()).flat().length}`
  );
  return out;
}

async function getGradesByCategoryIds(
  catIds: Array<GTGradeCategoryRow["id"]>
): Promise<GradesByCategory> {
  const out: GradesByCategory = new Map();
  if (catIds.length === 0) return out;

  console.log(`📝 Obteniendo notas para ${catIds.length} category IDs...`);

  for (const [chunkIndex, ids] of chunk(catIds, 100).entries()) {
    try {
      if (chunkIndex > 0) await sleep(100);

      const { data, error } = (await supabase
        .from("gt_grades")
        .select("id, category_id, name, score, enabled, updated_at")
        .in("category_id", ids)) as unknown as {
        data: GTGradeRow[] | null;
        error: any;
      };

      if (error) {
        console.error(`❌ Error en chunk ${chunkIndex + 1}:`, error);
        throw error;
      }

      if ((chunkIndex + 1) % 5 === 0 || chunkIndex === 0) {
        console.log(`  ✅ Chunks 1-${chunkIndex + 1}: notas acumuladas`);
      }
      for (const g of data || []) {
        const arr = out.get(g.category_id) || [];
        arr.push(g);
        out.set(g.category_id, arr);
      }
    } catch (e: any) {
      console.error(
        `❌ Error en getGradesByCategoryIds chunk ${chunkIndex + 1}:`,
        e.message
      );
      throw e;
    }
  }
  console.log(
    `📝 Total notas obtenidas: ${Array.from(out.values()).flat().length}`
  );
  return out;
}

async function pageUserPreferences({
  from = 0,
  to = pageSize - 1,
}: {
  from?: number;
  to?: number;
}): Promise<{
  data: Array<{
    student_code: string | number;
    preferences: any;
    updated_at: string;
  }>;
  count: number;
}> {
  let q = supabase
    .from("user_preferences")
    .select("student_code, preferences, updated_at", { count: "exact" })
    .order("updated_at", { ascending: true })
    .range(from, to);

  if (MIGRATE_SINCE) q = q.gte("updated_at", MIGRATE_SINCE);

  const { data, error, count } = (await q) as unknown as {
    data: Array<{
      student_code: string | number;
      preferences: any;
      updated_at: string;
    }> | null;
    error: any;
    count: number | null;
  };
  if (error) throw error;
  return { data: data || [], count: count || 0 };
}

// ---------------------- Escrituras Firestore --------

function buildSimulationEmbeddedIndexed(
  categories: GTGradeCategoryRow[],
  gradesByCat: GradesByCategory
): {
  categories: Record<string, { name: string; weight: number | null }>;
  grades: Record<
    string,
    {
      categoryIndex: number;
      name: string;
      score: number | null;
      enabled: boolean;
    }
  >;
} {
  const categoriesMap: Record<string, { name: string; weight: number | null }> =
    {};
  const gradesMap: Record<
    string,
    {
      categoryIndex: number;
      name: string;
      score: number | null;
      enabled: boolean;
    }
  > = {};

  const sortedCats = [...categories].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
  );
  const catIndexById = new Map<string, number>();

  sortedCats.forEach((c, idx) => {
    const idStr = String(c.id);
    catIndexById.set(idStr, idx);
    categoriesMap[String(idx)] = {
      name: c.name,
      weight: numberOrNull(c.weight),
    };
  });

  let gradeIdx = 0;
  for (const c of sortedCats) {
    const catId = String(c.id);
    const catIdx = catIndexById.get(catId)!;
    const grades = gradesByCat.get(c.id) || [];
    for (const g of grades) {
      gradesMap[String(gradeIdx)] = {
        categoryIndex: catIdx,
        name: g.name,
        score: numberOrNull(g.score),
        enabled: bool(g.enabled),
      };
      gradeIdx += 1;
    }
  }

  return { categories: categoriesMap, grades: gradesMap };
}

function normalizeSemPrefPayload<T extends Record<string, any>>(
  payload: T = {} as T
) {
  const out: Record<string, any> = { ...payload };
  if (Array.isArray(out.schedule_hidden_events)) {
    out.scheduleHiddenEvents = out.schedule_hidden_events;
    delete out.schedule_hidden_events;
  }
  return out as T & { scheduleHiddenEvents?: unknown[] };
}

async function writeSimulationEmbedded({
  studentCode,
  courseCode,
  payload,
}: {
  studentCode: string;
  courseCode: string;
  payload: { categories: Record<string, any>; grades: Record<string, any> };
}) {
  const ref = db
    .collection("students")
    .doc(studentCode)
    .collection("gradeSimulations")
    .doc(courseCode);

  const body = {
    ...payload,
    lastModified: FieldValue.serverTimestamp(),
  };

  if (dryRun) {
    console.log("[DRY-RUN] set", ref.path);
    return;
  }

  try {
    // Escritura directa - MÁS CONFIABLE que BulkWriter
    await ref.set(body, { merge: true });
  } catch (e: any) {
    console.error(
      `❌ Error escribiendo ${studentCode}/${courseCode}:`,
      e.message
    );
    throw e;
  }
}

async function writeSimulationSubcollections({
  studentCode,
  courseCode,
  categories,
  gradesByCat,
}: {
  studentCode: string;
  courseCode: string;
  categories: GTGradeCategoryRow[];
  gradesByCat: GradesByCategory;
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

  await bulk.set(
    base,
    { lastModified: FieldValue.serverTimestamp() },
    { merge: true }
  );

  for (const c of categories) {
    const ref = base.collection("categories").doc(String(c.id));
    await bulk.set(
      ref,
      { id: String(c.id), name: c.name, weight: numberOrNull(c.weight) },
      { merge: true }
    );
  }

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

async function writePreferences({
  studentCode,
  preferences,
}: {
  studentCode: string;
  preferences: PreferencesJSON | Record<string, any>;
}) {
  const studentRef = db.collection("students").doc(studentCode);

  const prefs = safePrefs(preferences) as PreferencesJSON;
  const global = normalizeGlobal((prefs.global as Record<string, any>) || {});
  const semestersData = (prefs._semesters && prefs._semesters.data) || {};

  const globalRef = studentRef.collection("preferences").doc("global");
  if (!dryRun) {
    await bulk.set(
      globalRef,
      { ...global, migratedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } else {
    console.log("[DRY-RUN] set", globalRef.path);
  }

  const dataCol = studentRef
    .collection("preferences")
    .doc("_semesters")
    .collection("data");

  for (const [semesterId, raw] of Object.entries(semestersData)) {
    const ref = dataCol.doc(String(semesterId));
    const payload = normalizeSemPrefPayload(safePrefs(raw));
    if (!dryRun) {
      await bulk.set(
        ref,
        {
          ...payload,
          migratedAt: FieldValue.serverTimestamp(),
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

  const {
    pageIndex: startIdx,
    from: ckFrom,
    to: ckTo,
  } = loadCheckpoint("sim", pageSize);
  let from = ckFrom,
    to = ckTo,
    pageIndex = startIdx;
  let total = 0;
  let processed = 0;

  console.log("🔍 Obteniendo count inicial de registros...");
  const first = await withReadRetries(() =>
    pageCourseTrackings({ since: MIGRATE_SINCE, from, to })
  );
  total = first.count;
  console.log(
    `Registros en gt_course_tracking (filtro desde=${iso(
      MIGRATE_SINCE
    )}): ${total}`
  );
  if (pageIndex > 0) {
    console.log(
      `📍 Reanudando desde página ${pageIndex + 1} (from=${from}, to=${to})`
    );
  }

  while (processed < total) {
    console.log(
      `📄 Procesando página ${pageIndex + 1} (from: ${from}, to: ${to})...`
    );

    const { data } =
      pageIndex === startIdx
        ? first
        : await withReadRetries(() =>
            pageCourseTrackings({ since: MIGRATE_SINCE, from, to })
          );

    if (!data || data.length === 0) {
      console.log("📄 No hay más datos, terminando loop de páginas");
      break;
    }

    console.log(
      `📄 Página ${pageIndex + 1}: obtenidos ${
        data.length
      } registros de course_tracking`
    );

    const trackIds = data.map((t) => t.id);
    console.log(
      `🔍 Buscando categorías para tracking IDs: ${trackIds
        .slice(0, 5)
        .join(", ")}${trackIds.length > 5 ? "..." : ""}`
    );

    const byTrack = await getCategoriesByTrackIds(trackIds);

    const allCats = Array.from(byTrack.values()).flat();
    console.log(
      `📊 Total categorías encontradas en esta página: ${allCats.length}`
    );

    const gradesByCat = await getGradesByCategoryIds(allCats.map((c) => c.id));

    console.log(
      `🚀 Iniciando escrituras a Firestore para ${data.length} documentos...`
    );

    const limit = pLimit(concurrency);
    const jobs: Array<Promise<unknown>> = [];

    for (const t of data) {
      const studentCode = String(t.student_code);
      const courseCode = String(t.course_code);
      const categories = byTrack.get(t.id) || [];

      jobs.push(
        limit(async () => {
          try {
            if (structureMode === "embedded") {
              const payload = buildSimulationEmbeddedIndexed(
                categories,
                gradesByCat
              );
              const roughSize = Buffer.byteLength(
                JSON.stringify(payload),
                "utf8"
              );
              if (roughSize > 900_000) {
                console.warn(
                  "⚠️ Doc grande:",
                  studentCode,
                  courseCode,
                  roughSize
                );
                recordFailed({
                  type: "oversize",
                  studentCode,
                  courseCode,
                  roughSize,
                });
                return; // saltar este doc
              }
              await writeSimulationEmbedded({
                studentCode,
                courseCode,
                payload,
              });
            } else {
              await writeSimulationSubcollections({
                studentCode,
                courseCode,
                categories,
                gradesByCat,
              });
            }
          } catch (e: any) {
            recordFailed({
              type: "sim",
              studentCode,
              courseCode,
              err: e.message,
            });
          }
        })
      );
    }

    console.log(`🧵 Jobs creados: ${jobs.length}. Esperando confirmación...`);
    const waitAll = Promise.all(jobs);
    const warnTimer = setTimeout(() => {
      console.log("⏳ Aún esperando confirmación de escrituras (10s)...");
    }, 10_000);

    // Timeout de emergencia para evitar cuelgues indefinidos
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Timeout: escrituras tardaron más de 60s"));
      }, 60_000);
    });

    try {
      await Promise.race([waitAll, timeoutPromise]);
      console.log(`✅ Página ${pageIndex + 1} completada`);
    } catch (e: any) {
      console.error(`❌ Error en página ${pageIndex + 1}:`, e.message);
      if (e.message.includes("Timeout")) {
        console.log("🔍 Verificando estado de BulkWriter...");
        console.log(`📊 Total writes registrados: ${totalWrites}`);
        throw new Error(
          "BulkWriter timeout - posible problema de conectividad/permisos"
        );
      }
      throw e;
    } finally {
      clearTimeout(warnTimer);
    }

    processed += data.length;
    console.log(
      `  • Página ${pageIndex + 1}: ${
        data.length
      } elementos → acumulado ${processed}/${total}`
    );
    pageIndex += 1;
    from += pageSize;
    to += pageSize;
    saveCheckpoint("sim", { pageIndex, from, to });
    await sleep(50);
  }

  console.log(`==> gradeSimulations listo. Procesados: ${processed}`);
}

async function migratePreferencesAll() {
  console.log("==> Migrando user_preferences...");

  const {
    pageIndex: startIdx,
    from: ckFrom,
    to: ckTo,
  } = loadCheckpoint("prefs", pageSize);
  let from = ckFrom,
    to = ckTo,
    pageIndex = startIdx;
  let total = 0;
  let processed = 0;

  const first = await withReadRetries(() => pageUserPreferences({ from, to }));
  total = first.count;
  console.log(
    `Registros en user_preferences (filtro desde=${iso(
      MIGRATE_SINCE
    )}): ${total}`
  );
  if (pageIndex > 0) {
    console.log(
      `📍 Reanudando desde página ${pageIndex + 1} (from=${from}, to=${to})`
    );
  }

  while (true) {
    const { data } =
      pageIndex === startIdx
        ? first
        : await withReadRetries(() => pageUserPreferences({ from, to }));
    if (!data || data.length === 0) break;

    const limit = pLimit(concurrency);
    const jobs: Array<Promise<unknown>> = [];

    for (const r of data) {
      const studentCode = String(r.student_code);
      const prefsRow = safePrefs(r.preferences);
      jobs.push(
        limit(async () => {
          try {
            await writePreferences({ studentCode, preferences: prefsRow });
          } catch (e: any) {
            recordFailed({ type: "prefs", studentCode, err: e.message });
          }
        })
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
    saveCheckpoint("prefs", { pageIndex, from, to });
    await sleep(50);
  }

  console.log(`==> user_preferences listo. Procesados: ${processed}`);
}

// Añadir hooks para ver errores silenciosos en runtime
process.on("unhandledRejection", (reason: any) => {
  console.error("💥 UnhandledRejection:", reason?.stack || reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("💥 UncaughtException:", err?.stack || err);
});

// ---------------------- Main ------------------------

(async function main(): Promise<void> {
  const started = Date.now();
  console.log("🚀 Iniciando migración Supabase → Firestore");
  console.log(`   Modo estructura: ${structureMode} | DRY_RUN=${dryRun}`);
  console.log(`   Checkpoint: ${CKPT_PATH} | Failed: ${FAILED_LOG_PATH}`);
  try {
    await migrateSimulations();
    await migratePreferencesAll();

    if (!dryRun) {
      console.log("⏳ Esperando flush de BulkWriter...");
      await bulk.close(); // asegura que todo se haya enviado
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✅ Migración terminada en ${secs}s`);

    try {
      if (fs.existsSync(FAILED_LOG_PATH)) {
        const failedLines = fs
          .readFileSync(FAILED_LOG_PATH, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l);
        if (failedLines.length > 0) {
          console.log(
            `⚠️ ${failedLines.length} elementos fallaron (ver ${FAILED_LOG_PATH})`
          );
        }
      }
    } catch {
      // noop
    }
  } catch (err) {
    console.error("❌ Error durante la migración:", err);
    try {
      await bulk.close();
    } catch {
      // noop
    }
    process.exit(1);
  }
})();
