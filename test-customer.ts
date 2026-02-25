import { storage } from "./server/storage";
import { db } from "./server/db";

async function main() {
  try {
    const customer = await storage.createCustomer({
      name: "Maria Testkundin",
      address: "Musterstraße 12, 04103 Leipzig",
      billingType: "pflegekasse_gesetzlich",
      vorname: "Maria",
      nachname: "Testkundin",
      strasse: "Musterstraße",
      nr: "12",
      plz: "04103",
      stadt: "Leipzig",
      geburtsdatum: "1942-05-15",
      email: "alrikdegenkolb@gmx.de",
      telefon: "+491721234567",
      pflegegrad: 2,
      pflegegradSeit: "2025-01-01",
      acceptsPrivatePayment: false,
      documentDeliveryMethod: "email",
      haustierVorhanden: false,
      personenbefoerderungGewuenscht: false,
      status: "active",
    } as any);
    
    console.log("Customer created:", customer.id, customer.vorname, customer.nachname);
    
    // Add budgets
    await storage.upsertCustomerBudgets(customer.id, {
      entlastungsbetrag45b: 13100,
      pflegesachleistungen36: 0,
      verhinderungspflege39: 353900,
      validFrom: "2025-01-01",
    });
    console.log("Budgets created");
    
    // Create contract
    await storage.createContract(customer.id, {
      contractStart: "2026-02-25",
      contractDate: "2026-02-25",
      vereinbarteLeistungen: "Einkaufen, Spaziergang, Fenster putzen",
      hoursPerPeriod: 0,
      periodType: "month",
    });
    console.log("Contract created");
    
    console.log("\nCustomer ID:", customer.id);
    process.exit(0);
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
