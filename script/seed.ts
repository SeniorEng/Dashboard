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
    }
  ];

  const insertedCustomers = await db.insert(customers).values(customerData).returning();
  console.log(`✓ Inserted ${insertedCustomers.length} customers`);

  // Insert appointments for today
  const today = new Date().toISOString().split('T')[0];
  
  const appointmentData = [
    {
      customerId: insertedCustomers[0].id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date: today,
      time: "09:00",
      durationPromised: 45,
      status: "completed"
    },
    {
      customerId: insertedCustomers[1].id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date: today,
      time: "11:30",
      durationPromised: 60,
      status: "scheduled"
    },
    {
      customerId: insertedCustomers[2].id,
      appointmentType: "Kundentermin",
      serviceType: "Hauswirtschaft",
      date: today,
      time: "14:00",
      durationPromised: 90,
      status: "scheduled"
    },
    {
      customerId: insertedCustomers[0].id,
      appointmentType: "Erstberatung",
      serviceType: null,
      date: today,
      time: "16:30",
      durationPromised: 60,
      status: "scheduled"
    }
  ];

  const insertedAppointments = await db.insert(appointments).values(appointmentData).returning();
  console.log(`✓ Inserted ${insertedAppointments.length} appointments`);

  console.log("Database seeded successfully!");
}

seed().catch((error) => {
  console.error("Error seeding database:", error);
  process.exit(1);
});
