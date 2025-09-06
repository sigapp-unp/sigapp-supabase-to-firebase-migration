import fs from "fs";
import { SupabaseClient } from "@supabase/supabase-js";

type CkptShape = Record<
  string,
  { pageIndex: number; from: number; to: number; ts: string }
>;

export function loadCheckpoint(
  stage: string,
  pageSizeNum: number,
  ckptPath = "./checkpoint.json"
): { pageIndex: number; from: number; to: number } {
  try {
    const raw = fs.readFileSync(ckptPath, "utf8");
    const ckpt = JSON.parse(raw) as CkptShape;
    const entry = ckpt && ckpt[stage];
    if (
      entry &&
      typeof entry.pageIndex === "number" &&
      typeof entry.from === "number" &&
      typeof entry.to === "number"
    ) {
      return { pageIndex: entry.pageIndex, from: entry.from, to: entry.to };
    }
    return { pageIndex: 0, from: 0, to: pageSizeNum - 1 };
  } catch {
    return { pageIndex: 0, from: 0, to: pageSizeNum - 1 };
  }
}

export function saveCheckpoint(
  stage: string,
  { pageIndex, from, to }: { pageIndex: number; from: number; to: number },
  ckptPath = "./checkpoint.json"
) {
  let ckpt: CkptShape = {};
  try {
    const raw = fs.readFileSync(ckptPath, "utf8");
    ckpt = JSON.parse(raw) as CkptShape;
  } catch {
    // ignore
  }
  ckpt[stage] = { pageIndex, from, to, ts: new Date().toISOString() };

  // Atomic write: write to tmp then rename
  const tmp = ckptPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 2));
  fs.renameSync(tmp, ckptPath);
}

export async function ensureCheckpointWithinBounds(opts: {
  stage: string;
  table: string;
  pageSize: number;
  migrateSince?: string | undefined;
  supabase: SupabaseClient;
  withReadRetries: <T>(fn: () => Promise<T>) => Promise<T>;
  ckptPath?: string;
}): Promise<{
  pageIndex: number;
  from: number;
  to: number;
  totalCount: number;
  skipStage: boolean;
}> {
  const { stage, table, pageSize, migrateSince, supabase, withReadRetries } =
    opts;
  const ckptPath = opts.ckptPath || "./checkpoint.json";

  const {
    pageIndex: startIdx,
    from: ckFrom,
    to: ckTo,
  } = loadCheckpoint(stage, pageSize, ckptPath);
  let pageIndex = startIdx;
  let from = ckFrom;
  let to = ckTo;

  // only validate when resuming
  if (pageIndex > 0) {
    const countRes = await withReadRetries(async () => {
      let q: any = supabase.from(table).select("id", { count: "exact" });
      if (migrateSince) q = q.gte("updated_at", migrateSince);
      return await q;
    });

    const totalCount = (countRes as any).count || 0;
    if (totalCount === 0) {
      return { pageIndex, from, to, totalCount, skipStage: true };
    }

    if (from >= totalCount) {
      const lastPageIndex = Math.max(
        0,
        Math.floor((totalCount - 1) / pageSize)
      );
      pageIndex = lastPageIndex;
      from = lastPageIndex * pageSize;
      to = from + pageSize - 1;
      saveCheckpoint(stage, { pageIndex, from, to }, ckptPath);
    }
    return { pageIndex, from, to, totalCount, skipStage: false };
  }

  return { pageIndex, from, to, totalCount: -1, skipStage: false };
}
