// ---------------------------------------------------------------------------
// Object-Storage-Verfügbarkeit für Tests (Task #1250)
//
// Die invoice-/PDF-Persistenz-Tests laden bzw. schreiben echte Objekte über den
// Replit-Object-Storage-Sidecar (`http://127.0.0.1:1106`). Lokal/in Replit ist
// der Sidecar vorhanden und `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS`
// gesetzt — dort laufen die Tests voll durch. In der GitHub-Actions-CI existiert
// der Sidecar NICHT (der `@google-cloud/storage`-Client holt sein Token von
// dort), deshalb werden diese Env-Variablen dort bewusst nicht gesetzt und die
// betroffenen Tests sauber übersprungen (gleiches CI-Muster wie „erechnung ohne
// Java" / „ci-seed ohne Secrets").
//
// Zwei Verwendungsarten:
//   1. Ganze Datei hängt am Object Storage → das hier exportierte `describe`
//      statt des vitest-`describe` importieren; es skippt automatisch, wenn die
//      Env fehlt:
//        import { describe } from "../helpers/object-storage";
//   2. Nur einzelne Suiten einer gemischten Datei hängen am Object Storage →
//      `hasObjectStorageEnv` importieren und gezielt:
//        describe.skipIf(!hasObjectStorageEnv)("…", () => { … })
// ---------------------------------------------------------------------------
import { describe as vitestDescribe } from "vitest";

export const hasObjectStorageEnv =
  !!process.env.PRIVATE_OBJECT_DIR && !!process.env.PUBLIC_OBJECT_SEARCH_PATHS;

/**
 * `describe`, das die gesamte Suite überspringt, wenn kein Object Storage
 * verfügbar ist. Drop-in-Ersatz für das vitest-`describe` in Dateien, deren
 * Tests AUSNAHMSLOS echten Object-Storage-Zugriff brauchen.
 */
export const describe = hasObjectStorageEnv ? vitestDescribe : vitestDescribe.skip;
