#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Supabase -> Cloud Firestore migration (TypeScript / Node.js)
 *
 * - Reads tables:
 *    gt_course_tracking, gt_grade_categories, gt_grades, user_preferences
 * - Writes to Firestore:
 *    /students/{studentCode}/gradeSimulations/{courseCode}
 *        { categories: Map, grades: Map, lastModified: serverTimestamp }
 *    /students/{studentCode}/preferences/global
 *    /students/{studentCode}/preferences/_semesters/data/{semesterId}
 *
 * Configuration: see .env or environment variables.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import {
  loadCheckpoint,
  saveCheckpoint,
  ensureCheckpointWithinBounds,
} from "./checkpoint";
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
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

if (!FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_PATH in .env");
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
import { FirestoreWriterManager } from "./firestoreClient";
const writer = new FirestoreWriterManager(db, { dryRun });
// Comentar el onWriteResult problemático por ahora
// bulk.onWriteResult((_ref: any) => {
//   totalWrites += 1;
//   if (totalWrites % 50 === 0) {
//     console.log(`✳️ ${totalWrites} escrituras confirmadas`);
//   }
// });

// ---------------------- Utilidades ------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// checkpoint helpers are in ./checkpoint.ts

// Small logging helpers to make the run more observable
function saveCheckpointQuiet(
  stage: string,
  ck: { pageIndex: number; from: number; to: number }
) {
  try {
    saveCheckpoint(stage, ck);
    // Solo log en caso de error
  } catch (e: any) {
    console.error(`❌ Checkpoint save failed [${stage}]:`, e?.message ?? e);
  }
}

async function closeWriterAndLog(timeoutMs = 30_000) {
  try {
    console.log(`⏳ Closing BulkWriter (timeout ${timeoutMs}ms)...`);
    const p = writer.close();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Writer close timeout")), timeoutMs)
    );
    await Promise.race([p, timeout]);
    console.log(
      `✅ BulkWriter closed. Total writes: ${writer.getTotalWrites()}`
    );
  } catch (e: any) {
    console.error(`❌ Error closing writer:`, e?.message ?? e);
    console.log(
      `  Total writes recorded before error: ${writer.getTotalWrites()}`
    );
  }
}

function recordFailed(rec: Record<string, unknown>) {
  fs.appendFileSync(
    FAILED_LOG_PATH,
    JSON.stringify({ ...rec, ts: new Date().toISOString() }) + "\n"
  );
}

async function withReadRetries<T>(
  fn: () => Promise<T>,
  operation = "Supabase query"
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) console.log(`🔄 Retry ${attempt}/3: ${operation}`);
      return await fn();
    } catch (e: any) {
      if (attempt === 3) {
        console.error(`💥 Failed after 3 attempts: ${e?.message ?? e}`);
        throw e;
      }
      console.log(
        `❌ Attempt ${attempt} failed: ${e?.message ?? e}. Retrying...`
      );
      await sleep(1000 * attempt);
    }
  }
  throw new Error("Unreachable");
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
      console.error("❌ Error in pageCourseTrackings:", error);
      throw error;
    }
    return { data: data || [], count: count || 0 };
  } catch (e: any) {
    console.error("❌ Error in pageCourseTrackings:", e.message);
    throw e;
  }
}

async function getCategoriesByTrackIds(
  trackIds: Array<GTCourseTrackingRow["id"]>
): Promise<CategoriesByTrack> {
  const out: CategoriesByTrack = new Map();
  if (trackIds.length === 0) return out;

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
        console.error(`❌ Error in categories chunk ${chunkIndex + 1}:`, error);
        throw error;
      }

      for (const c of data || []) {
        const arr = out.get(c.course_tracking_id) || [];
        arr.push(c);
        out.set(c.course_tracking_id, arr);
      }
    } catch (e: any) {
      console.error(
        `❌ Error in getCategoriesByTrackIds chunk ${chunkIndex + 1}:`,
        e.message
      );
      throw e;
    }
  }

  return out;
}

async function getGradesByCategoryIds(
  catIds: Array<GTGradeCategoryRow["id"]>
): Promise<GradesByCategory> {
  const out: GradesByCategory = new Map();
  if (catIds.length === 0) return out;

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
        console.error(`❌ Error in grades chunk ${chunkIndex + 1}:`, error);
        throw error;
      }

      for (const g of data || []) {
        const arr = out.get(g.category_id) || [];
        arr.push(g);
        out.set(g.category_id, arr);
      }
    } catch (e: any) {
      console.error(
        `❌ Error in getGradesByCategoryIds chunk ${chunkIndex + 1}:`,
        e.message
      );
      throw e;
    }
  }

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
    // Direct write - MORE RELIABLE than BulkWriter
    await ref.set(body, { merge: true });
  } catch (e: any) {
    console.error(`❌ Error writing ${studentCode}/${courseCode}:`, e.message);
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

  await writer.set(
    base,
    { lastModified: FieldValue.serverTimestamp() },
    { merge: true }
  );

  for (const c of categories) {
    const ref = base.collection("categories").doc(String(c.id));
    await writer.set(
      ref,
      { id: String(c.id), name: c.name, weight: numberOrNull(c.weight) },
      { merge: true }
    );
  }

  for (const c of categories) {
    const grades = gradesByCat.get(c.id) || [];
    for (const g of grades) {
      const ref = base.collection("grades").doc(String(g.id));
      await writer.set(
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
  console.log(`🔍 DEBUG - writePreferences START for student ${studentCode}`);
  const studentRef = db.collection("students").doc(studentCode);

  const prefs = safePrefs(preferences) as PreferencesJSON;
  const global = normalizeGlobal((prefs.global as Record<string, any>) || {});
  const semestersData = (prefs._semesters && prefs._semesters.data) || {};

  const globalRef = studentRef.collection("preferences").doc("global");
  if (!dryRun) {
    // Usar escritura directa para preferencias (pocas) - más confiable
    await globalRef.set(
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
      // Usar escritura directa para preferencias
      await ref.set(
        { ...payload, migratedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    } else {
      console.log("[DRY-RUN] set", ref.path);
    }
  }

  console.log(`🔍 DEBUG - writePreferences END for student ${studentCode}`);
}

// ---------------------- Proceso principal -----------

async function migrateSimulations() {
  const stageStartTime = Date.now();
  console.log("🎯 STAGE 1/2: Grade Simulations Migration");

  const {
    pageIndex: startIdx,
    from: ckFrom,
    to: ckTo,
  } = loadCheckpoint("sim", pageSize);
  let from = ckFrom,
    to = ckTo,
    pageIndex = startIdx;
  let total = 0;
  let processedInSession = 0;

  // Ensure checkpoint 'from' is within current table bounds. If resuming
  // from an old checkpoint where the table (or filtered set) is now smaller
  // this prevents Supabase PostgREST PGRST103 (range not satisfiable).
  console.log("  Getting record count...");

  const ck = await ensureCheckpointWithinBounds({
    stage: "sim",
    table: "gt_course_tracking",
    pageSize,
    migrateSince: MIGRATE_SINCE,
    supabase,
    withReadRetries,
    ckptPath: CKPT_PATH,
  });

  if (ck.skipStage) {
    console.log("⏭️  No records to migrate. Skipping grade simulations.");
    return;
  }

  pageIndex = ck.pageIndex;
  from = ck.from;
  to = ck.to;

  const first = await withReadRetries(
    () => pageCourseTrackings({ since: MIGRATE_SINCE, from, to }),
    "initial count query"
  );
  total = first.count;
  const totalProcessed = pageIndex * pageSize;
  const maxPageIndex = Math.max(0, Math.floor((total - 1) / pageSize));

  console.log(
    `  Found ${total} records to migrate (since ${iso(MIGRATE_SINCE)})`
  );

  if (pageIndex > 0) {
    const percent = ((totalProcessed / total) * 100).toFixed(1);
    console.log(
      `📍 Resuming from page ${pageIndex + 1}/${
        maxPageIndex + 1
      } - ${totalProcessed}/${total} already processed (${percent}%)`
    );
  }

  // If the saved checkpoint already points past the last page, mark stage done
  if (pageIndex > maxPageIndex) {
    console.log(`✅ Grade simulations already complete`);
    saveCheckpointQuiet("sim", {
      pageIndex: maxPageIndex + 1,
      from: total,
      to: total + pageSize,
    });
    return;
  }

  while (true) {
    const currentTotal = totalProcessed + processedInSession;

    // Si ya procesamos todo, salir
    if (currentTotal >= total || from >= total) {
      console.log(
        `✅ Reached end of available records (${currentTotal}/${total})`
      );
      break;
    }

    console.log(`📄 Page ${pageIndex + 1}: Processing records ${from}-${to}`);

    const { data } =
      pageIndex === startIdx
        ? first
        : await withReadRetries(
            () => pageCourseTrackings({ since: MIGRATE_SINCE, from, to }),
            "page query"
          );

    if (!data || data.length === 0) {
      console.log("✅ No more data available");
      break;
    }

    // Fetch related data
    const trackIds = data.map((t) => t.id);
    const byTrack = await getCategoriesByTrackIds(trackIds);
    const allCats = Array.from(byTrack.values()).flat();
    const gradesByCat = await getGradesByCategoryIds(allCats.map((c) => c.id));

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

    try {
      await Promise.all(jobs);
    } catch (e: any) {
      console.error(`❌ Error on page ${pageIndex + 1}:`, e.message);
      throw e;
    }

    processedInSession += data.length;
    const newTotal = totalProcessed + processedInSession;
    const percent = ((newTotal / total) * 100).toFixed(1);

    console.log(
      `✅ Page ${pageIndex + 1} complete → ${newTotal}/${total} (${percent}%)`
    );

    pageIndex += 1;
    from += pageSize;
    to += pageSize;
    saveCheckpointQuiet("sim", { pageIndex, from, to });
    await sleep(50);
  }

  const elapsed = ((Date.now() - stageStartTime) / 1000 / 60).toFixed(1);
  console.log(
    `✅ Grade Simulations Complete (${processedInSession} processed this session, ${elapsed}m elapsed)`
  );

  // persist a final checkpoint indicating stage completion
  try {
    saveCheckpointQuiet("sim", {
      pageIndex: maxPageIndex + 1,
      from: total,
      to: total + pageSize,
    });
  } catch {
    // noop
  }
}

async function migratePreferencesAll() {
  const stageStartTime = Date.now();
  console.log("🎯 STAGE 2/2: User Preferences Migration");

  const {
    pageIndex: startIdx,
    from: ckFrom,
    to: ckTo,
  } = loadCheckpoint("prefs", pageSize);
  let from = ckFrom,
    to = ckTo,
    pageIndex = startIdx;
  let total = 0;
  let processedInSession = 0;

  // Clamp checkpoint against current total for user_preferences (centralized)
  const ck = await ensureCheckpointWithinBounds({
    stage: "prefs",
    table: "user_preferences",
    pageSize,
    migrateSince: MIGRATE_SINCE,
    supabase,
    withReadRetries,
    ckptPath: CKPT_PATH,
  });

  if (ck.skipStage) {
    console.log("⏭️  No records to migrate. Skipping user preferences.");
    return;
  }

  pageIndex = ck.pageIndex;
  from = ck.from;
  to = ck.to;

  const first = await withReadRetries(
    () => pageUserPreferences({ from, to }),
    "preferences count query"
  );
  total = first.count;
  const totalProcessed = pageIndex * pageSize;
  const maxPageIndex = Math.max(0, Math.floor((total - 1) / pageSize));

  console.log(
    `  Found ${total} user preference records to migrate (since ${iso(
      MIGRATE_SINCE
    )})`
  );

  if (pageIndex > 0) {
    const percent = ((totalProcessed / total) * 100).toFixed(1);
    console.log(
      `📍 Resuming from page ${pageIndex + 1}/${
        maxPageIndex + 1
      } - ${totalProcessed}/${total} already processed (${percent}%)`
    );
  }

  // If checkpoint already past last page, mark prefs stage done and exit
  if (pageIndex > maxPageIndex) {
    console.log(`✅ User preferences already complete`);
    saveCheckpointQuiet("prefs", {
      pageIndex: maxPageIndex + 1,
      from: total,
      to: total + pageSize,
    });
    return;
  }

  while (true) {
    console.log(
      `🔍 DEBUG - Starting new loop iteration: pageIndex=${pageIndex}, from=${from}, to=${to}`
    );
    const currentTotal = totalProcessed + processedInSession;

    // Si ya procesamos todo, salir
    if (currentTotal >= total) {
      console.log(
        `✅ Reached end of available preference records (${currentTotal}/${total})`
      );
      break;
    }

    // Si from está más allá del total, también salir
    if (from >= total) {
      console.log(
        `✅ Page range beyond total records (from=${from} >= total=${total})`
      );
      break;
    }

    // Limit 'to' to the actual number of records available
    const adjustedTo = Math.min(to, total - 1);

    console.log(
      `📄 Page ${
        pageIndex + 1
      }: Processing preferences ${from}-${adjustedTo} (original range: ${from}-${to})`
    );

    console.log(
      `🔍 DEBUG - Loop state: from=${from}, to=${to}, adjustedTo=${adjustedTo}, total=${total}`
    );
    console.log(
      `🔍 DEBUG - currentTotal=${currentTotal}, totalProcessed=${totalProcessed}, processedInSession=${processedInSession}`
    );

    const { data } =
      pageIndex === startIdx
        ? first
        : await withReadRetries(
            () => pageUserPreferences({ from, to: adjustedTo }),
            "preferences page query"
          );

    console.log(`🔍 DEBUG - Query returned ${data?.length || 0} records`);

    if (!data || data.length === 0) {
      console.log("✅ No more preference data available");
      break;
    }

    console.log(`   Processing ${data.length} preference records...`);
    console.log(
      `🔍 DEBUG - Starting Promise.all for ${data.length} records...`
    );

    // BulkWriter maneja su propia concurrencia, no necesitamos pLimit
    const jobs: Array<Promise<unknown>> = [];

    for (const r of data) {
      const studentCode = String(r.student_code);
      const prefsRow = safePrefs(r.preferences);
      jobs.push(
        (async () => {
          try {
            await writePreferences({ studentCode, preferences: prefsRow });
          } catch (e: any) {
            recordFailed({ type: "prefs", studentCode, err: e.message });
          }
        })()
      );
    }

    console.log(
      `🔍 DEBUG - About to execute Promise.all for ${jobs.length} jobs...`
    );

    try {
      await Promise.all(jobs);
      console.log(`🔍 DEBUG - Promise.all completed successfully!`);
    } catch (e: any) {
      console.error(`❌ ERROR in Promise.all for preferences:`, e.message);
      throw e;
    }

    processedInSession += data.length;
    const newTotal = totalProcessed + processedInSession;
    const percent = ((newTotal / total) * 100).toFixed(1);

    console.log(
      `✅ Page ${pageIndex + 1} complete → ${newTotal}/${total} (${percent}%)`
    );

    console.log(
      `🔍 DEBUG - Updating loop variables: pageIndex ${pageIndex} -> ${
        pageIndex + 1
      }, from ${from} -> ${from + pageSize}`
    );
    pageIndex += 1;
    from += pageSize;
    to += pageSize;
    saveCheckpointQuiet("prefs", { pageIndex, from, to });
    console.log(`🔍 DEBUG - Checkpoint saved, sleeping 50ms...`);
    await sleep(50);
    console.log(`🔍 DEBUG - About to check loop conditions again...`);
  }

  console.log(
    `🔍 DEBUG - Exited while loop! About to show completion message...`
  );
  const elapsed = ((Date.now() - stageStartTime) / 1000 / 60).toFixed(1);
  console.log(
    `✅ User Preferences Complete (${processedInSession} processed this session, ${elapsed}m elapsed)`
  );

  // persist a final checkpoint indicating prefs stage completion
  try {
    saveCheckpointQuiet("prefs", {
      pageIndex: maxPageIndex + 1,
      from: total,
      to: total + pageSize,
    });
  } catch {
    // noop
  }
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
  console.log("🚀 Starting Supabase → Firestore Migration");
  console.log(
    `   Mode: ${structureMode} | Dry Run: ${dryRun} | Since: ${
      MIGRATE_SINCE || "beginning"
    }`
  );
  console.log(`   Page Size: ${pageSize} | Concurrency: ${concurrency}`);
  console.log("");

  let simsProcessed = 0;
  let prefsProcessed = 0;

  try {
    console.log(`🔍 DEBUG - Starting migrateSimulations()...`);
    await migrateSimulations();
    console.log(
      `🔍 DEBUG - migrateSimulations() completed, starting migratePreferencesAll()...`
    );
    await migratePreferencesAll();
    console.log(
      `🔍 DEBUG - migratePreferencesAll() completed! dryRun=${dryRun}`
    );

    if (!dryRun) {
      console.log("⏳ Finalizing writes...");
      await closeWriterAndLog();
      console.log(`🔍 DEBUG - closeWriterAndLog() completed!`);
    }

    console.log(`🔍 DEBUG - About to show migration summary...`);
    const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
    const totalWrites = writer.getTotalWrites();

    console.log("");
    console.log("📋 MIGRATION SUMMARY");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`⏱️  Total time: ${elapsed}m`);
    console.log(`🎯 Grade simulations: Complete`);
    console.log(`🎯 User preferences: Complete`);
    console.log(`  Total Firestore writes: ${totalWrites}`);

    // Check for failed items
    try {
      if (fs.existsSync(FAILED_LOG_PATH)) {
        const failedLines = fs
          .readFileSync(FAILED_LOG_PATH, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l);
        if (failedLines.length > 0) {
          console.log(
            `⚠️  Issues: ${failedLines.length} items failed (see ${FAILED_LOG_PATH})`
          );
        } else {
          console.log(`✅ Success rate: 100%`);
        }
      } else {
        console.log(`✅ Success rate: 100%`);
      }
    } catch {
      // noop
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Migration completed successfully`);
  } catch (err) {
    console.log("");
    console.error("❌ Migration failed:", err);
    try {
      await writer.close();
    } catch {
      // noop
    }
    process.exit(1);
  }
})();
