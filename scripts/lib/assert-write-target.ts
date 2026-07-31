// ---------------------------------------------------------------------------
// Side-Effect-Modul: prüft BEIM IMPORT, ob der schreibende Entrypoint auf einer
// Wegwerf-DB landet.
//
// Warum als eigenes Modul und nicht als Aufruf in `main()`: ESM wertet Importe
// vor dem Modulkörper aus. Stünde die Prüfung erst in `main()`, liefen
// `server/lib/db` bzw. `server/storage` samt ihrer Modul-Seiteneffekte schon
// vorher. Heute ist das harmlos (nur Pool-Konfiguration, kein Connect), aber es
// macht den Guard von einer Eigenschaft fremder Module abhängig. Als ERSTER
// Import in den Seed-Skripten läuft die Prüfung garantiert zuerst.
//
// Dieses Modul importiert bewusst NUR Node-Builtins + die Guard-SSoT.
// ---------------------------------------------------------------------------
import { basename } from "node:path";
import { assertEphemeralDbForWrite } from "./ephemeral-db-guard";

try {
  assertEphemeralDbForWrite(
    basename(process.argv[1] ?? "") || "schreibender Entrypoint",
  );
} catch (err) {
  // Der Wurf läge ausserhalb des try/catch in `main()` der Seed-Skripte und
  // käme als roher Node-Stacktrace um den gerahmten Kasten heraus. Hier sauber
  // abbrechen: nur die Meldung, Exit ≠ 0.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
