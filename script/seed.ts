import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { customers, appointments } from "../shared/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function seed() {
  console.log("Seeding database...");

  // Insert customers with German needs descriptions
  const customerData = [
    {
      name: "Gerda Müller",
      address: "Lindenstraße 42, 10969 Berlin",
      avatar: "lady",
      needs: ["Mobilitätshilfe", "Medikamentenerinnerung"]
    },
    {
      name: "Hans Schmidt",
      address: "Bergmannstraße 12, 10961 Berlin",
      avatar: "man",
      needs: ["Gesellschaft", "Leichte Hausarbeit"]
    },
    {
      name: "Elfriede Weber",
      address: "Gneisenaustraße 88, 10961 Berlin",
      avatar: "lady",
      needs: ["Einkaufshilfe", "Kochhilfe"]
    },
    {
      name: "Werner Braun",
      address: "Oranienstraße 55, 10969 Berlin",
      avatar: "man",
      needs: ["Begleitung zu Arztterminen", "Dokumentenorganisation"]
    }
  ];

  const insertedCustomers = await db.insert(customers).values(customerData).returning();
  console.log(`✓ Inserted ${insertedCustomers.length} customers`);

  // Insert appointments for today - balanced between Erstberatung and Kundentermin
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  
  const appointmentData = [
    // Kundentermin with Alltagsbegleitung (completed)
    {
      customerId: insertedCustomers[0].id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date: today,
      time: "09:00",
      scheduledStart: "09:00",
      durationPromised: 45,
      status: "completed"
    },
    // Kundentermin with Hauswirtschaft (scheduled)
    {
      customerId: insertedCustomers[1].id,
      appointmentType: "Kundentermin",
      serviceType: "Hauswirtschaft",
      date: today,
      time: "10:30",
      scheduledStart: "10:30",
      durationPromised: 60,
      status: "scheduled"
    },
    // Erstberatung (scheduled) - no service type
    {
      customerId: insertedCustomers[2].id,
      appointmentType: "Erstberatung",
      serviceType: null,
      date: today,
      time: "13:00",
      scheduledStart: "13:00",
      durationPromised: 60,
      status: "scheduled"
    },
    // Kundentermin with Alltagsbegleitung (scheduled)
    {
      customerId: insertedCustomers[1].id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date: today,
      time: "15:00",
      scheduledStart: "15:00",
      durationPromised: 45,
      status: "scheduled"
    },
    // Erstberatung (completed) - no service type
    {
      customerId: insertedCustomers[3].id,
      appointmentType: "Erstberatung",
      serviceType: null,
      date: today,
      time: "16:30",
      scheduledStart: "16:30",
      durationPromised: 60,
      status: "completed"
    }
  ];

  const insertedAppointments = await db.insert(appointments).values(appointmentData).returning();
  console.log(`✓ Inserted ${insertedAppointments.length} appointments`);
  console.log("  - 2 Erstberatung appointments");
  console.log("  - 3 Kundentermin appointments (2 Alltagsbegleitung, 1 Hauswirtschaft)");

  console.log("Database seeded successfully!");
}

seed().catch((error) => {
  console.error("Error seeding database:", error);
  process.exit(1);
});
