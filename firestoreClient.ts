export class FirestoreWriterManager {
  private db: any;
  private bulk: any;
  private dryRun: boolean;
  private totalWrites = 0;
  private pending = 0;
  private successes = 0;
  private failures = 0;

  constructor(db: any, opts?: { dryRun?: boolean }) {
    this.db = db;
    this.dryRun = !!opts?.dryRun;

    if (!this.dryRun) {
      this.bulk = db.bulkWriter();

      // register handlers
      try {
        this.bulk.onWriteResult((res: any) => {
          this.totalWrites += 1;
          this.successes += 1;
          this.pending = Math.max(0, this.pending - 1);
          if (this.totalWrites % 50 === 0) {
            console.log(`✳️ ${this.totalWrites} writes confirmed`);
          }
        });
      } catch {
        // ignore if API differs
      }

      try {
        this.bulk.onWriteError((err: any) => {
          if ((err as any).failedAttempts < 5) {
            return true; // let Firestore retry
          }
          this.failures += 1;
          console.error("❌ Write error (no retry):", err);
          return false;
        });
      } catch {
        // ignore
      }
    }
  }

  async set(
    ref: any,
    data: any,
    opts?: { merge?: boolean; useBulk?: boolean }
  ) {
    if (this.dryRun) {
      console.log("[DRY-RUN] set", ref.path);
      return;
    }
    const useBulk = opts?.useBulk !== undefined ? opts.useBulk : true;
    if (!useBulk) {
      await ref.set(data, { merge: !!opts?.merge });
      this.totalWrites += 1;
      this.successes += 1;
      return;
    }
    this.pending += 1;
    // delegate to BulkWriter
    await this.bulk.set(ref, data, opts);
  }

  getTotalWrites() {
    return this.totalWrites;
  }

  getStats() {
    return {
      pending: this.pending,
      successes: this.successes,
      failures: this.failures,
      total: this.totalWrites,
    };
  }

  async close(timeoutMs = 60_000) {
    if (this.dryRun) return;
    if (!this.bulk) return;
    const closePromise = this.bulk.close();
    return Promise.race([
      closePromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("BulkWriter close timeout")),
          timeoutMs
        )
      ),
    ]);
  }
}
